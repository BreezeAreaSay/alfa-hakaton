"""Очередь заданий в PostgreSQL: постановка в той же транзакции, захват через SKIP LOCKED."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.domain.enums import JobKind, JobStatus
from app.models import Job


def now() -> datetime:
    return datetime.now(UTC)


def enqueue(
    db: Session,
    kind: JobKind,
    application_id: uuid.UUID | None,
    payload: dict[str, Any] | None = None,
    run_at: datetime | None = None,
) -> Job:
    job = Job(
        kind=kind, application_id=application_id, payload=payload or {}, status=JobStatus.QUEUED, run_at=run_at or now()
    )
    db.add(job)
    return job


def claim(db: Session, worker_id: str) -> Job | None:
    job = db.scalars(
        select(Job)
        .where(Job.status == JobStatus.QUEUED, Job.run_at <= now())
        .order_by(Job.run_at, Job.id)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).first()
    if job is None:
        return None
    job.status = JobStatus.RUNNING
    job.locked_at = now()
    job.locked_by = worker_id
    job.attempts += 1
    db.commit()
    return job


def finish(db: Session, job: Job) -> None:
    job.status = JobStatus.DONE
    job.finished_at = now()


def reschedule(db: Session, job: Job, run_at: datetime, error: str | None = None) -> None:
    job.status = JobStatus.QUEUED
    job.run_at = run_at
    job.locked_at = None
    job.locked_by = None
    job.last_error = error


def fail(db: Session, job: Job, error: str) -> None:
    job.status = JobStatus.FAILED
    job.last_error = error
    job.finished_at = now()


def cancel_for_application(db: Session, application_id: uuid.UUID) -> None:
    db.execute(
        update(Job)
        .where(Job.application_id == application_id, Job.status == JobStatus.QUEUED)
        .values(status=JobStatus.CANCELLED, finished_at=now())
    )


def requeue_stale(db: Session, lock_timeout_seconds: int) -> int:
    """Возвращает в очередь задания, захваченные упавшим обработчиком."""
    result = db.execute(
        update(Job)
        .where(Job.status == JobStatus.RUNNING, Job.locked_at < now() - timedelta(seconds=lock_timeout_seconds))
        .values(status=JobStatus.QUEUED, locked_at=None, locked_by=None)
    )
    return result.rowcount or 0
