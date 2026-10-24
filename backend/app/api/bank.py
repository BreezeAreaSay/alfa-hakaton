"""Рабочее место кредитного аналитика: очередь, досье, решение, запрос информации."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.domain.catalog import ProductTerms
from app.domain.enums import (
    Actor,
    AppStatus,
    Audience,
    DecisionKind,
    InfoOrigin,
    JobStatus,
    OfferKind,
    OfferStatus,
    Outcome,
    StepStatus,
)
from app.domain.labels import INFO_ITEM_PRESETS, STATUS_LABELS, STEP_LABELS
from app.domain.policy import (
    FLAGS,
    LIMIT_PHRASES,
    STOP_FACTORS,
    PolicyDecision,
    check_analyst_terms,
    compute_limit,
    eligibility_issues,
    offer_figures,
    rate_for,
)
from app.domain.review import PRIORITY_RANK, review_priority
from app.domain.scoring import score
from app.domain.text import MSK
from app.models import Application, AuditLog, Company, Decision, InfoRequest, Job, Offer, PipelineStep, Product, User
from app.pipeline.steps import collect_inputs, run_results, save_decision
from app.schemas import (
    ApplicationOut,
    BankMetrics,
    BankSummary,
    DecisionRequest,
    InfoRequestCreate,
    QueueItem,
    TermsPreview,
    TermsPreviewRequest,
)
from app.security import bank_staff
from app.services import events
from app.services.audit import audit
from app.services.justification import justification_pdf
from app.services.metrics import bank_metrics
from app.services.views import application_out, latest_decision, latest_scoring, payment_label
from app.services.workflow import transition

router = APIRouter(prefix="/api/bank", tags=["Рабочее место банка"])

ACTIVE = [
    AppStatus.SUBMITTED,
    AppStatus.IN_PROCESSING,
    AppStatus.NEED_INFO,
    AppStatus.MANUAL_REVIEW,
    AppStatus.OFFER,
    AppStatus.ACCEPTED,
    AppStatus.SIGNING,
    AppStatus.SIGNED,
]


def now() -> datetime:
    return datetime.now(UTC)


def load(db: Session, application_id: uuid.UUID, lock: bool = False) -> Application:
    application = db.get(Application, application_id, with_for_update=lock)
    if application is None or application.status == AppStatus.DRAFT:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заявка не найдена")
    return application


def waiting_source(db: Session, application: Application) -> str | None:
    if application.status != AppStatus.IN_PROCESSING:
        return None
    for code, row in run_results(db, application).items():
        if row.status == StepStatus.WAITING:
            return STEP_LABELS[code]["title"]
    return None


@router.get("/summary", response_model=BankSummary, summary="Счётчики для шапки рабочего места")
def summary(user: User = Depends(bank_staff), db: Session = Depends(get_db)) -> BankSummary:
    def count(*conditions) -> int:
        return db.scalar(select(func.count()).select_from(Application).where(*conditions)) or 0

    waiting = db.scalar(
        select(func.count(func.distinct(PipelineStep.application_id)))
        .join(Application, Application.id == PipelineStep.application_id)
        .where(PipelineStep.status == StepStatus.WAITING, Application.status == AppStatus.IN_PROCESSING)
    )
    # «Выдано сегодня» — с полуночи по Москве, как день в показателях конвейера
    midnight = now().astimezone(MSK).replace(hour=0, minute=0, second=0, microsecond=0)
    return BankSummary(
        manual_review=count(Application.status == AppStatus.MANUAL_REVIEW),
        mine=count(Application.status == AppStatus.MANUAL_REVIEW, Application.assignee_id == user.id),
        overdue=count(Application.status == AppStatus.MANUAL_REVIEW, Application.sla_due_at < now()),
        need_info=count(Application.status == AppStatus.NEED_INFO),
        in_processing=count(Application.status.in_([AppStatus.SUBMITTED, AppStatus.IN_PROCESSING])),
        waiting_sources=waiting or 0,
        offers=count(Application.status == AppStatus.OFFER),
        issued_today=count(Application.status == AppStatus.ISSUED, Application.closed_at >= midnight),
    )


@router.get("/metrics", response_model=BankMetrics, summary="Показатели конвейера за период")
def metrics(
    days: int = Query(default=30, ge=1, le=365, description="Период в днях, считая сегодня"),
    user: User = Depends(bank_staff),
    db: Session = Depends(get_db),
) -> BankMetrics:
    return bank_metrics(db, days=days, now=now())


@router.get("/applications", response_model=list[QueueItem], summary="Очередь заявок")
def queue_list(
    status_filter: list[AppStatus] | None = Query(default=None, alias="status"),
    product: str | None = None,
    risk_class: str | None = None,
    mine: bool = False,
    q: str | None = None,
    include_closed: bool = False,
    user: User = Depends(bank_staff),
    db: Session = Depends(get_db),
) -> list[QueueItem]:
    query = select(Application).join(Company, Company.id == Application.company_id)
    if status_filter:
        query = query.where(Application.status.in_(status_filter))
    elif not include_closed:
        query = query.where(Application.status.in_(ACTIVE))
    else:
        query = query.where(Application.status != AppStatus.DRAFT)
    if product:
        query = query.where(Application.product_code == product)
    if mine:
        query = query.where(Application.assignee_id == user.id)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(Company.name.ilike(like) | Company.inn.like(like) | Application.number.like(like))
    rows = db.scalars(query.order_by(Application.status_changed_at.desc()).limit(300)).all()

    moment = now()
    items = []
    for a in rows:
        scoring = latest_scoring(db, a)
        decision = latest_decision(db, a)
        if risk_class and (scoring is None or scoring.risk_class != risk_class):
            continue
        flags = decision.flags if decision else []
        priority, reasons = review_priority(
            a.status, now=moment, sla_due_at=a.sla_due_at, amount=Decimal(a.amount), flags=flags
        )
        items.append(
            QueueItem(
                id=a.id,
                number=a.number,
                company_name=a.company.name,
                inn=a.company.inn,
                legal_form=a.company.legal_form,
                product_code=a.product_code,
                product_name=a.product.name,
                amount=a.amount,
                term_months=a.term_months,
                status=a.status,
                status_label=STATUS_LABELS[a.status]["bank"],
                risk_class=scoring.risk_class if scoring else None,
                score=scoring.score if scoring else None,
                flags=flags,
                assignee_name=a.assignee.full_name if a.assignee else None,
                assignee_is_me=a.assignee_id == user.id,
                sla_due_at=a.sla_due_at if a.status == AppStatus.MANUAL_REVIEW else None,
                overdue=bool(a.status == AppStatus.MANUAL_REVIEW and a.sla_due_at and a.sla_due_at < moment),
                priority=priority,
                priority_reasons=reasons,
                submitted_at=a.submitted_at,
                status_changed_at=a.status_changed_at,
                waiting_source=waiting_source(db, a),
            )
        )
    # Сверху ручное рассмотрение: по приоритету, внутри него — по сроку рассмотрения; дальше остальные статусы
    order = {AppStatus.MANUAL_REVIEW: 0, AppStatus.IN_PROCESSING: 1, AppStatus.NEED_INFO: 2}
    items.sort(
        key=lambda i: (
            order.get(i.status, 3),
            PRIORITY_RANK.get(i.priority, len(PRIORITY_RANK)),
            i.sla_due_at or i.status_changed_at,
        )
    )
    return items


@router.post(
    "/applications/{application_id}/assign",
    response_model=ApplicationOut,
    summary="Взять в работу или забрать себе заявку другого аналитика",
)
def assign(
    application_id: uuid.UUID, user: User = Depends(bank_staff), db: Session = Depends(get_db)
) -> ApplicationOut:
    """Ничья заявка назначается на сотрудника («Взять в работу»), заявка другого аналитика переходит к нему
    («Взять себе»). В журнал пишется `ASSIGNED`: к кому, а при передаче — и от кого. Повтор по своей заявке
    ничего не меняет."""
    application = load(db, application_id, lock=True)
    if application.status not in (AppStatus.MANUAL_REVIEW, AppStatus.NEED_INFO):
        raise HTTPException(status.HTTP_409_CONFLICT, "Взять в работу можно заявку на ручном рассмотрении")
    if application.assignee_id == user.id:
        return application_out(db, application, user)
    previous = application.assignee
    application.assignee_id = user.id
    details = {"to": user.login} if previous is None else {"from": previous.login, "to": user.login}
    audit(
        db,
        actor=Actor.UNDERWRITER,
        user=user,
        action="ASSIGNED",
        entity_type="application",
        entity_id=application.id,
        details=details,
    )
    # Прежний исполнитель и другие сотрудники видят нового исполнителя без перезагрузки
    events.emit(db, application, audience=Audience.BANK, kind="ASSIGNED", title="ASSIGNED", notify=False)
    db.commit()
    return application_out(db, application, user)


@router.get("/applications/{application_id}/dossier", summary="Досье заявки: источники, скоринг, политика, журнал")
def dossier(application_id: uuid.UUID, user: User = Depends(bank_staff), db: Session = Depends(get_db)) -> dict:
    application = load(db, application_id)
    steps = run_results(db, application)
    scoring = latest_scoring(db, application)
    auto = db.scalars(
        select(Decision)
        .where(Decision.application_id == application.id, Decision.kind == DecisionKind.AUTO)
        .order_by(Decision.id.desc())
    ).first()
    last = latest_decision(db, application)

    limit = None
    if scoring is not None:
        features = collect_inputs(db, application)
        s = score(features)
        terms = ProductTerms.from_model(application.product)
        rate = rate_for(terms, s)
        if rate is not None:
            result = compute_limit(
                terms,
                features,
                rate=rate,
                term_months=application.term_months,
                collateral_value=Decimal(application.collateral_value) if application.collateral_value else None,
            )
            limit = {
                "limit": float(result.limit) if result.limit is not None else None,
                "binding": result.binding,
                "phrase": LIMIT_PHRASES.get(result.binding or ""),
                "constraints": result.constraints,
                "rate": float(rate),
            }

    def decision_view(d: Decision | None) -> dict | None:
        if d is None:
            return None
        return {
            "id": d.id,
            "kind": d.kind,
            "outcome": d.outcome,
            "policy_version": d.policy_version,
            "limit": float(d.limit_amount) if d.limit_amount is not None else None,
            "limit_binding": d.limit_binding,
            "rate": float(d.rate) if d.rate is not None else None,
            "flags": [{"code": c, "title": FLAGS.get(c, c)} for c in d.flags],
            "stop_factors": [{"code": c, "title": STOP_FACTORS.get(c, c)} for c in d.stop_factors],
            "reason_codes": d.reason_codes,
            "trace": d.trace,
            "comment": d.comment,
            "decided_by": db.get(User, d.decided_by).full_name if d.decided_by else None,
            "created_at": d.created_at,
        }

    audit_rows = db.scalars(
        select(AuditLog).where(AuditLog.entity_id == str(application.id)).order_by(AuditLog.id.desc()).limit(100)
    ).all()
    users = {u.id: u.full_name for u in db.scalars(select(User))}
    priority, priority_reasons = review_priority(
        application.status,
        now=now(),
        sla_due_at=application.sla_due_at,
        amount=Decimal(application.amount),
        flags=last.flags if last else [],
    )
    return {
        "application": application_out(db, application, user),
        "sources": {
            code: {
                "status": row.status,
                "result": row.result,
                "error": row.error,
                "attempts": row.attempts,
                "finished_at": row.finished_at,
            }
            for code, row in steps.items()
        },
        "scoring": None
        if scoring is None
        else {
            "score": scoring.score,
            "risk_class": scoring.risk_class,
            "pd": float(scoring.pd),
            "version": scoring.scoring_version,
            "factors": scoring.factors,
            "features": scoring.features,
        },
        "auto_decision": decision_view(auto),
        "last_decision": decision_view(last),
        "limit": limit,
        "assignee": application.assignee.full_name if application.assignee else None,
        "assignee_is_me": application.assignee_id == user.id,
        "sla_due_at": application.sla_due_at,
        "priority": priority,
        "priority_reasons": priority_reasons,
        "audit": [
            {
                "action": r.action,
                "actor": r.actor,
                "user": users.get(r.actor_user_id),
                "details": r.details,
                "created_at": r.created_at,
            }
            for r in audit_rows
        ],
        "info_item_presets": INFO_ITEM_PRESETS,
    }


def _terms(
    db: Session,
    application: Application,
    product_code: str,
    amount: Decimal,
    term: int,
    rate: Decimal | None,
    comment: str | None,
) -> tuple[TermsPreview, ProductTerms, Decimal | None]:
    product = db.get(Product, product_code)
    if product is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Такого продукта нет")
    terms = ProductTerms.from_model(product)
    features = collect_inputs(db, application)
    s = score(features)
    min_rate = rate_for(terms, s)
    effective_rate = rate or min_rate or terms.base_rate + Decimal(5)
    collateral = Decimal(application.collateral_value) if application.collateral_value else None
    limit = compute_limit(terms, features, rate=effective_rate, term_months=term, collateral_value=collateral)
    errors = [
        i.text
        for i in eligibility_issues(
            terms,
            business_months=features.business_months,
            is_bank_client=features.is_bank_client,
            account_months=features.account_months,
        )
    ]
    if terms.collateral_required and not collateral:
        errors.append("Для продукта нужен залог")
    errors += check_analyst_terms(
        terms,
        amount=amount,
        term_months=term,
        rate=effective_rate,
        limit=limit.limit,
        min_rate=min_rate,
        comment=comment,
    )
    monthly, over = offer_figures(terms, amount, effective_rate, term)
    preview = TermsPreview(
        limit=limit.limit,
        limit_binding=limit.binding,
        limit_phrase=LIMIT_PHRASES.get(limit.binding or ""),
        min_rate=min_rate,
        rate=effective_rate,
        monthly_payment=monthly,
        overpayment=over,
        payment_label=payment_label(terms.kind),
        errors=errors,
        constraints=limit.constraints,
    )
    return preview, terms, limit.limit


@router.post(
    "/applications/{application_id}/terms-preview",
    response_model=TermsPreview,
    summary="Предварительный расчёт условий для решения аналитика",
)
def terms_preview(
    application_id: uuid.UUID,
    body: TermsPreviewRequest,
    user: User = Depends(bank_staff),
    db: Session = Depends(get_db),
) -> TermsPreview:
    application = load(db, application_id)
    preview, _, _ = _terms(db, application, body.product_code, body.amount, body.term_months, body.rate, "preview")
    return preview


@router.post(
    "/applications/{application_id}/decision",
    response_model=ApplicationOut,
    summary="Решение аналитика: одобрить, контрпредложение, отказ",
)
def decide_manually(
    application_id: uuid.UUID, body: DecisionRequest, user: User = Depends(bank_staff), db: Session = Depends(get_db)
) -> ApplicationOut:
    application = load(db, application_id, lock=True)
    if application.status != AppStatus.MANUAL_REVIEW:
        raise HTTPException(status.HTTP_409_CONFLICT, "Решение можно принять только по заявке на ручном рассмотрении")
    application.assignee_id = application.assignee_id or user.id

    if body.action == "REJECT":
        if not body.reason_code:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите причину отказа")
        if not (body.comment and body.comment.strip()):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Добавьте комментарий к отказу")
        d = PolicyDecision(outcome=Outcome.REJECT, reason_codes=[body.reason_code])
        d.note("Решение аналитика", "отказ", body.comment)
        save_decision(db, application, d, kind=DecisionKind.MANUAL, user=user, comment=body.comment)
        transition(
            db,
            application,
            AppStatus.REJECTED,
            actor=Actor.UNDERWRITER,
            user=user,
            reason=f"{body.reason_code}: {body.comment}",
        )
        db.commit()
        return application_out(db, application, user)

    if body.action == "APPROVE":
        product_code, amount, term = application.product_code, Decimal(application.amount), application.term_months
    else:
        product_code = body.product_code or application.product_code
        amount = body.amount or Decimal(application.amount)
        term = body.term_months or application.term_months
    preview, terms, limit = _terms(db, application, product_code, amount, term, body.rate, body.comment)
    if preview.errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "; ".join(preview.errors))

    as_requested = (product_code, amount, term) == (
        application.product_code,
        Decimal(application.amount),
        application.term_months,
    )
    d = PolicyDecision(
        outcome=Outcome.APPROVE if as_requested else Outcome.COUNTER,
        rate=preview.rate,
        limit=limit,
        limit_binding=preview.limit_binding,
    )
    d.note("Решение аналитика", "одобрено" if as_requested else "контрпредложение", body.comment or "")
    decision = save_decision(db, application, d, kind=DecisionKind.MANUAL, user=user, comment=body.comment)
    db.add(
        Offer(
            application_id=application.id,
            decision_id=decision.id,
            option_no=1,
            kind=OfferKind.AS_REQUESTED if as_requested else OfferKind.COUNTER,
            product_code=terms.code,
            amount=amount,
            term_months=term,
            rate=preview.rate,
            monthly_payment=preview.monthly_payment,
            overpayment=preview.overpayment,
            valid_until=now() + timedelta(hours=get_settings().offer_ttl_hours),
            status=OfferStatus.ACTIVE,
            note=None if as_requested else "Условия предложены специалистом банка",
        )
    )
    transition(
        db,
        application,
        AppStatus.OFFER,
        actor=Actor.UNDERWRITER,
        user=user,
        reason=body.comment or ("Одобрено" if as_requested else "Контрпредложение"),
    )
    db.commit()
    return application_out(db, application, user)


@router.post(
    "/applications/{application_id}/info-requests",
    response_model=ApplicationOut,
    summary="Запросить у клиента документы или пояснения",
)
def request_info(
    application_id: uuid.UUID, body: InfoRequestCreate, user: User = Depends(bank_staff), db: Session = Depends(get_db)
) -> ApplicationOut:
    application = load(db, application_id, lock=True)
    if application.status != AppStatus.MANUAL_REVIEW:
        raise HTTPException(status.HTTP_409_CONFLICT, "Запросить информацию можно по заявке на ручном рассмотрении")
    presets = {p["code"]: p for p in INFO_ITEM_PRESETS}
    unknown = [code for code in body.items if code not in presets]
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Неизвестные пункты запроса: {', '.join(unknown)}")
    application.assignee_id = application.assignee_id or user.id
    db.add(
        InfoRequest(
            application_id=application.id,
            origin=InfoOrigin.UNDERWRITER,
            requested_by=user.id,
            items=[presets[code] for code in body.items],
            comment=body.comment,
            due_at=now() + timedelta(hours=body.due_hours),
        )
    )
    transition(
        db,
        application,
        AppStatus.NEED_INFO,
        actor=Actor.UNDERWRITER,
        user=user,
        reason=", ".join(presets[c]["title"] for c in body.items),
    )
    db.commit()
    return application_out(db, application, user)


@router.post(
    "/applications/{application_id}/restart",
    response_model=ApplicationOut,
    summary="Перезапустить автоматическую проверку (например, после сбоя источника)",
)
def restart(
    application_id: uuid.UUID, user: User = Depends(bank_staff), db: Session = Depends(get_db)
) -> ApplicationOut:
    application = load(db, application_id, lock=True)
    transition(
        db,
        application,
        AppStatus.IN_PROCESSING,
        actor=Actor.UNDERWRITER,
        user=user,
        reason="Перезапуск автоматической проверки",
    )
    db.commit()
    return application_out(db, application, user)


@router.post(
    "/applications/{application_id}/pipeline/retry",
    response_model=ApplicationOut,
    summary="Повторить ожидающий шаг конвейера сейчас",
)
def retry_now(
    application_id: uuid.UUID, user: User = Depends(bank_staff), db: Session = Depends(get_db)
) -> ApplicationOut:
    application = load(db, application_id)
    jobs = db.scalars(select(Job).where(Job.application_id == application.id, Job.status == JobStatus.QUEUED)).all()
    for job in jobs:
        job.run_at = now()
    audit(
        db,
        actor=Actor.UNDERWRITER,
        user=user,
        action="PIPELINE_RETRY",
        entity_type="application",
        entity_id=application.id,
    )
    db.commit()
    return application_out(db, application, user)


@router.get("/pipeline/issues", summary="Заявки, которые ждут внешние источники или упали с ошибкой")
def pipeline_issues(user: User = Depends(bank_staff), db: Session = Depends(get_db)) -> list[dict]:
    issues = []
    for application in db.scalars(select(Application).where(Application.status.in_(ACTIVE))):
        for code, row in run_results(db, application).items():
            if row.status in (StepStatus.WAITING, StepStatus.FAILED) and (
                application.status == AppStatus.IN_PROCESSING or row.status == StepStatus.FAILED
            ):
                issues.append(
                    {
                        "application_id": application.id,
                        "number": application.number,
                        "company_name": application.company.name,
                        "status": application.status,
                        "step": code,
                        "step_title": STEP_LABELS[code]["title"],
                        "step_status": row.status,
                        "attempts": row.attempts,
                        "error": row.error,
                        "waiting_since": row.waiting_since,
                        "next_retry_at": row.next_retry_at,
                    }
                )
    failed_jobs = db.scalars(select(Job).where(Job.status == JobStatus.FAILED).order_by(Job.id.desc()).limit(20))
    for job in failed_jobs:
        application = db.get(Application, job.application_id) if job.application_id else None
        issues.append(
            {
                "application_id": job.application_id,
                "number": application.number if application else None,
                "company_name": application.company.name if application else None,
                "status": application.status if application else None,
                "step": job.kind,
                "step_title": f"Задание {job.kind}",
                "step_status": "FAILED",
                "attempts": job.attempts,
                "error": job.last_error,
                "waiting_since": job.created_at,
                "next_retry_at": None,
            }
        )
    return issues


@router.get(
    "/applications/{application_id}/justification.pdf",
    summary="Обоснование решения по заявке для аудита (PDF)",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}, "description": "PDF с обоснованием решения"}},
)
def justification(
    application_id: uuid.UUID, user: User = Depends(bank_staff), db: Session = Depends(get_db)
) -> Response:
    """Входные данные источников, скоринг, правила политики, решения людей, предложения, подписание и выдача —
    по сохранённым данным заявки. Формирование записывается в журнал действий."""
    application = load(db, application_id)
    pdf, file_name = justification_pdf(db, application, user)
    audit(
        db,
        actor=Actor(user.role),
        user=user,
        action="JUSTIFICATION_GENERATED",
        entity_type="application",
        entity_id=application.id,
        details={"file": file_name, "sha256": hashlib.sha256(pdf).hexdigest()},
    )
    db.commit()
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(file_name)}"},
    )
