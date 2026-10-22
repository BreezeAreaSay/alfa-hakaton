"""Обработчик конвейера: потоки берут задания из очереди, главный поток раз в несколько секунд проверяет таймеры.

Шаги конвейера в основном ждут ответов внешних систем, поэтому один процесс ведёт несколько заявок
одновременно (WORKER_CONCURRENCY потоков). Несколько процессов тоже работают вместе: задания разбираются
через SELECT … FOR UPDATE SKIP LOCKED.
"""

import logging
import os
import signal
import socket
import threading
import time
from datetime import UTC, datetime, timedelta

from prometheus_client import start_http_server
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.domain.enums import Actor, AppStatus, Audience, InfoStatus, JobStatus, OfferStatus
from app.logging_setup import setup_logging
from app.models import Application, InfoRequest, Job, Offer
from app.pipeline import queue
from app.pipeline.steps import JOB_HANDLERS, retry_delay
from app.services import events
from app.services.workflow import transition
from app.telemetry import APPLICATIONS, JOB_DURATION, JOBS, QUEUE_JOBS

log = logging.getLogger("worker")
MAX_JOB_ATTEMPTS = 8


class Worker:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.worker_id = f"{socket.gethostname()}-{os.getpid()}"
        self._stopped = threading.Event()

    @property
    def running(self) -> bool:
        return not self._stopped.is_set()

    def stop(self, *_: object) -> None:
        log.info("Остановка обработчика")
        self._stopped.set()

    def run(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        threads = [
            threading.Thread(target=self.loop, args=(f"{self.worker_id}-{index}",), name=f"jobs-{index}", daemon=True)
            for index in range(1, max(self.settings.worker_concurrency, 1) + 1)
        ]
        for thread in threads:
            thread.start()
        if self.settings.worker_metrics_port:
            start_http_server(self.settings.worker_metrics_port)
        log.info("Обработчик запущен: %s, потоков: %s", self.worker_id, len(threads))
        while self.running:
            self.sweep()
            self._stopped.wait(self.settings.worker_sweep_seconds)
        # Текущие задания доделываются; дольше внешнего таймаута ждать нечего
        for thread in threads:
            thread.join(timeout=self.settings.external_timeout_seconds + 5)

    def loop(self, worker_id: str) -> None:
        while self.running:
            if not self.process_one(worker_id):
                self._stopped.wait(self.settings.worker_poll_seconds)

    def process_one(self, worker_id: str) -> bool:
        with SessionLocal() as db:
            try:
                job = queue.claim(db, worker_id)
            except Exception:
                log.exception("Не удалось взять задание")
                db.rollback()
                return False
            if job is None:
                return False
            job_id, kind = job.id, job.kind
            started = time.monotonic()
            try:
                JOB_HANDLERS[job.kind](db, job)
                db.commit()
                JOBS.labels(kind=kind, result="done").inc()
                log.info(
                    "Задание выполнено",
                    extra={
                        "job_id": job_id,
                        "kind": job.kind,
                        "application_id": str(job.application_id),
                        "step": job.payload.get("step"),
                        "duration_ms": round((time.monotonic() - started) * 1000),
                    },
                )
            except Exception as error:
                db.rollback()
                JOBS.labels(kind=kind, result="error").inc()
                log.exception("Ошибка задания %s", job_id)
                self.handle_failure(db, job_id, error)
            JOB_DURATION.labels(kind=kind).observe(time.monotonic() - started)
            return True

    def handle_failure(self, db: Session, job_id: int, error: Exception) -> None:
        job = db.get(Job, job_id)
        if job is None:
            return
        message = f"{error.__class__.__name__}: {error}"
        if job.attempts >= MAX_JOB_ATTEMPTS:
            queue.fail(db, job, message)
            application = db.get(Application, job.application_id) if job.application_id else None
            events.emit(
                db,
                application,
                audience=Audience.BANK,
                kind="JOB_FAILED",
                title=f"Ошибка конвейера по заявке № {application.number if application else '—'}",
                body=message,
            )
        else:
            queue.reschedule(db, job, queue.now() + timedelta(seconds=retry_delay(job.attempts)), message)
        db.commit()

    def sweep(self) -> None:
        """Таймеры процесса: истечение предложений и запросов информации, зависшие задания."""
        with SessionLocal() as db:
            try:
                requeued = queue.requeue_stale(db, self.settings.job_lock_timeout_seconds)
                if requeued:
                    log.warning("Возвращены в очередь зависшие задания: %s", requeued)
                expire_offers(db)
                expire_info_requests(db)
                db.commit()
                self.update_gauges(db)
            except Exception:
                db.rollback()
                log.exception("Ошибка при проверке таймеров")

    @staticmethod
    def update_gauges(db: Session) -> None:
        """Очередь и заявки по статусам для Prometheus. Сначала нули: статус без строк не хранит старое значение."""
        for status in JobStatus:
            QUEUE_JOBS.labels(status=status.value).set(0)
        for status, count in db.execute(select(Job.status, func.count()).group_by(Job.status)):
            QUEUE_JOBS.labels(status=status).set(count)
        for status in AppStatus:
            APPLICATIONS.labels(status=status.value).set(0)
        for status, count in db.execute(select(Application.status, func.count()).group_by(Application.status)):
            APPLICATIONS.labels(status=status).set(count)


def expire_offers(db: Session) -> None:
    now = datetime.now(UTC)
    applications = db.scalars(
        select(Application).where(Application.status == AppStatus.OFFER).with_for_update(skip_locked=True)
    ).all()
    for application in applications:
        offers = db.scalars(
            select(Offer).where(Offer.application_id == application.id, Offer.status == OfferStatus.ACTIVE)
        ).all()
        if offers and all(o.valid_until < now for o in offers):
            for offer in offers:
                offer.status = OfferStatus.EXPIRED
            transition(db, application, AppStatus.EXPIRED, actor=Actor.SYSTEM, reason="Истёк срок предложения")


def expire_info_requests(db: Session) -> None:
    now = datetime.now(UTC)
    requests = db.scalars(
        select(InfoRequest).where(InfoRequest.status == InfoStatus.OPEN, InfoRequest.due_at < now)
    ).all()
    for request in requests:
        application = db.get(Application, request.application_id, with_for_update=True)
        request.status = InfoStatus.EXPIRED
        if application and application.status == AppStatus.NEED_INFO:
            transition(db, application, AppStatus.EXPIRED, actor=Actor.SYSTEM, reason="Истёк срок ответа на запрос")


def main() -> None:
    setup_logging()
    Worker().run()


if __name__ == "__main__":
    main()
