"""Машина состояний заявки (docs/process.md, «Правила переходов»).

Каждый переход проверяется по таблице, а смена статуса, история, журнал действий, события, задания
обработчику и назначение аналитика при переходе в ручное рассмотрение записываются в одной транзакции
вызывающего кода.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.enums import FINAL_STATUSES, PIPELINE_ORDER, Actor, AppStatus, Audience, JobKind, Role, StepStatus
from app.domain.labels import STATUS_LABELS
from app.domain.review import pick_analyst
from app.models import Application, PipelineStep, StatusHistory, User
from app.pipeline import queue
from app.services import events
from app.services.audit import audit

S = AppStatus

ALLOWED: dict[tuple[AppStatus, AppStatus], frozenset[Actor]] = {
    (S.DRAFT, S.SUBMITTED): frozenset({Actor.CLIENT}),
    (S.SUBMITTED, S.IN_PROCESSING): frozenset({Actor.SYSTEM}),
    (S.IN_PROCESSING, S.NEED_INFO): frozenset({Actor.SYSTEM}),
    (S.IN_PROCESSING, S.MANUAL_REVIEW): frozenset({Actor.SYSTEM}),
    (S.IN_PROCESSING, S.OFFER): frozenset({Actor.SYSTEM}),
    (S.IN_PROCESSING, S.REJECTED): frozenset({Actor.SYSTEM}),
    (S.NEED_INFO, S.IN_PROCESSING): frozenset({Actor.CLIENT}),
    (S.NEED_INFO, S.MANUAL_REVIEW): frozenset({Actor.CLIENT}),
    (S.NEED_INFO, S.EXPIRED): frozenset({Actor.SYSTEM}),
    (S.MANUAL_REVIEW, S.OFFER): frozenset({Actor.UNDERWRITER}),
    (S.MANUAL_REVIEW, S.NEED_INFO): frozenset({Actor.UNDERWRITER}),
    (S.MANUAL_REVIEW, S.REJECTED): frozenset({Actor.UNDERWRITER}),
    (S.MANUAL_REVIEW, S.IN_PROCESSING): frozenset({Actor.UNDERWRITER}),
    (S.OFFER, S.ACCEPTED): frozenset({Actor.CLIENT}),
    (S.OFFER, S.DECLINED): frozenset({Actor.CLIENT}),
    (S.OFFER, S.EXPIRED): frozenset({Actor.SYSTEM}),
    (S.ACCEPTED, S.SIGNING): frozenset({Actor.SYSTEM}),
    (S.SIGNING, S.SIGNED): frozenset({Actor.CLIENT}),
    (S.SIGNED, S.ISSUED): frozenset({Actor.SYSTEM}),
}

CANCELLABLE = frozenset({S.SUBMITTED, S.IN_PROCESSING, S.NEED_INFO, S.MANUAL_REVIEW, S.OFFER, S.ACCEPTED, S.SIGNING})


class TransitionError(Exception):
    pass


def can_transition(current: AppStatus, target: AppStatus, actor: Actor) -> bool:
    if target == S.CANCELLED:
        return current in CANCELLABLE and actor == Actor.CLIENT
    return actor in ALLOWED.get((current, target), frozenset())


def start_pipeline(db: Session, application: Application) -> None:
    """Новый прогон конвейера: шаги в статусе «ожидает», первое задание в очередь."""
    application.run_no += 1
    for step in PIPELINE_ORDER:
        db.add(
            PipelineStep(application_id=application.id, run_no=application.run_no, step=step, status=StepStatus.PENDING)
        )
    queue.enqueue(db, JobKind.PIPELINE_STEP, application.id, {"run_no": application.run_no, "step": PIPELINE_ORDER[0]})


CLIENT_NOTICES: dict[AppStatus, tuple[str, str | None]] = {
    S.SUBMITTED: ("Заявка № {n} отправлена", "Начали проверку. Обычно это занимает несколько минут."),
    S.NEED_INFO: ("Нужна информация по заявке № {n}", "Ответьте на запрос банка в карточке заявки."),
    S.MANUAL_REVIEW: ("Заявку № {n} рассматривает специалист", "Ответим в течение рабочего дня."),
    S.OFFER: ("Предложение по заявке № {n} готово", "Посмотрите условия и примите решение."),
    S.REJECTED: ("Решение по заявке № {n}", "К сожалению, банк отказал. Причина — в карточке заявки."),
    S.SIGNING: ("Документы по заявке № {n} готовы", "Проверьте и подпишите договор в кабинете."),
    S.ISSUED: ("Кредит по заявке № {n} выдан", "Деньги поступили на счёт. График платежей — в кабинете."),
    S.EXPIRED: ("Срок по заявке № {n} истёк", "Можно подать новую заявку."),
}

BANK_NOTICES: dict[AppStatus, str] = {
    S.MANUAL_REVIEW: "Заявка № {n} ждёт рассмотрения",
    S.CANCELLED: "Клиент отозвал заявку № {n}",
    S.ACCEPTED: "Клиент принял предложение по заявке № {n}",
    S.DECLINED: "Клиент отказался от предложения по заявке № {n}",
}


def analyst_loads(db: Session) -> dict[str, int]:
    """Логин аналитика → сколько у него заявок на ручном рассмотрении. Администратор заявки не получает.

    Строки аналитиков блокируются до конца транзакции: заявки, одновременно пришедшие на рассмотрение
    в разных потоках обработчика, распределяются по очереди и не достаются обе одному аналитику.
    """
    analysts = db.scalars(
        select(User).where(User.role == Role.UNDERWRITER).order_by(User.login).with_for_update(key_share=True)
    ).all()
    counts = dict(
        db.execute(
            select(Application.assignee_id, func.count())
            .where(Application.status == S.MANUAL_REVIEW, Application.assignee_id.is_not(None))
            .group_by(Application.assignee_id)
        ).all()
    )
    return {analyst.login: counts.get(analyst.id, 0) for analyst in analysts}


def assign_automatically(db: Session, application: Application, login: str) -> None:
    """Назначить заявку аналитику без его участия: запись в журнале и личное уведомление ему."""
    analyst = db.scalars(select(User).where(User.login == login)).one()
    application.assignee_id = analyst.id
    audit(
        db,
        actor=Actor.SYSTEM,
        user=None,
        action="ASSIGNED",
        entity_type="application",
        entity_id=application.id,
        details={"auto": True, "to": analyst.login},
    )
    events.emit(
        db,
        application,
        audience=Audience.BANK,
        kind="ASSIGNED",
        title=f"Вам назначена заявка № {application.number}",
        user_id=analyst.id,
    )


def auto_assign(db: Session, application: Application) -> None:
    """Автораспределение при переходе в ручное рассмотрение (docs/process.md, «Очередь аналитиков»).

    Заявка, у которой исполнитель уже есть, остаётся у него: она вернулась после ответа клиента на запрос
    или после перезапуска проверки, и продолжает её тот же аналитик.
    """
    if not get_settings().auto_assign or application.assignee_id is not None:
        return
    login = pick_analyst(analyst_loads(db))
    if login is not None:
        assign_automatically(db, application, login)


def transition(
    db: Session,
    application: Application,
    target: AppStatus,
    *,
    actor: Actor,
    user: User | None = None,
    reason: str | None = None,
) -> None:
    current = AppStatus(application.status)
    if not can_transition(current, target, actor):
        raise TransitionError(f"Действие недоступно: заявка в статусе «{STATUS_LABELS[current]['client']}»")
    now = datetime.now(UTC)
    application.status = target
    application.status_changed_at = now
    if target == S.SUBMITTED:
        application.submitted_at = now
    if target == S.MANUAL_REVIEW:
        application.sla_due_at = now + timedelta(hours=get_settings().review_sla_hours)
    if target in FINAL_STATUSES:
        application.closed_at = now

    db.add(
        StatusHistory(
            application_id=application.id,
            from_status=current,
            to_status=target,
            actor=actor,
            actor_user_id=user.id if user else None,
            reason=reason,
        )
    )
    audit(
        db,
        actor=actor,
        user=user,
        action="STATUS_CHANGED",
        entity_type="application",
        entity_id=application.id,
        details={"from": current, "to": target, "reason": reason},
    )

    n = application.number
    events.emit(
        db,
        application,
        audience=Audience.ALL,
        kind="STATUS_CHANGED",
        title=STATUS_LABELS[target]["client"],
        notify=False,
        payload={"from": current, "to": target},
    )
    if target in CLIENT_NOTICES:
        title, body = CLIENT_NOTICES[target]
        events.emit(
            db, application, audience=Audience.CLIENT, kind=f"STATUS_{target}", title=title.format(n=n), body=body
        )
    if target in BANK_NOTICES:
        events.emit(
            db,
            application,
            audience=Audience.BANK,
            kind=f"STATUS_{target}",
            title=BANK_NOTICES[target].format(n=n),
            body=reason,
        )
    if target == S.MANUAL_REVIEW:
        auto_assign(db, application)

    # Задания обработчику — часть той же транзакции (transactional outbox).
    if target == S.SUBMITTED or (current in (S.NEED_INFO, S.MANUAL_REVIEW) and target == S.IN_PROCESSING):
        start_pipeline(db, application)
    elif target == S.ACCEPTED:
        queue.enqueue(db, JobKind.GENERATE_DOCS, application.id)
    elif target == S.SIGNED:
        queue.enqueue(db, JobKind.DISBURSE, application.id)
    if target in FINAL_STATUSES:
        queue.cancel_for_application(db, application.id)
