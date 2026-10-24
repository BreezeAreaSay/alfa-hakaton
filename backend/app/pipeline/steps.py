"""Шаги конвейера и задания после решения (docs/process.md, «Шаги конвейера»)."""

import logging
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.catalog import ProductTerms
from app.domain.enums import (
    PIPELINE_ORDER,
    Actor,
    AppStatus,
    Audience,
    ConsentType,
    DecisionKind,
    DocumentKind,
    DocumentSource,
    InfoOrigin,
    JobKind,
    OfferStatus,
    Outcome,
    StepCode,
    StepStatus,
)
from app.domain.features import Features, build_features
from app.domain.finance import payment_schedule
from app.domain.labels import STEP_LABELS
from app.domain.policy import FLAGS, POLICY_VERSION, PolicyDecision, decide
from app.domain.scoring import SCORING_VERSION, ScoreResult, score
from app.integrations.simulator import SourceNotFound, SourceUnavailable, external_systems
from app.models import (
    Application,
    Company,
    Consent,
    Decision,
    Document,
    InfoRequest,
    Job,
    Loan,
    Offer,
    PipelineStep,
    ScheduleItem,
    ScoringResult,
    User,
)
from app.pipeline import queue
from app.services import documents, events
from app.services.inn import is_valid_inn
from app.services.workflow import transition
from app.telemetry import DECISIONS, STEPS

log = logging.getLogger("pipeline")

EXTERNAL_STEPS = {StepCode.EGRUL, StepCode.FNS, StepCode.GIRBO, StepCode.BKI, StepCode.BANK}


class StopPipeline(Exception):
    """Шаг перевёл заявку в другой статус — дальше конвейер не идёт."""


@dataclass
class StepOutcome:
    status: StepStatus
    result: dict[str, Any] = field(default_factory=dict)


def now() -> datetime:
    return datetime.now(UTC)


def step_row(db: Session, application: Application, run_no: int, step: str) -> PipelineStep:
    return db.scalars(
        select(PipelineStep).where(
            PipelineStep.application_id == application.id,
            PipelineStep.run_no == run_no,
            PipelineStep.step == step,
        )
    ).one()


def run_results(db: Session, application: Application) -> dict[str, PipelineStep]:
    rows = db.scalars(
        select(PipelineStep).where(
            PipelineStep.application_id == application.id, PipelineStep.run_no == application.run_no
        )
    ).all()
    return {row.step: row for row in rows}


def latest_statement(db: Session, application: Application) -> dict[str, Any] | None:
    document = db.scalars(
        select(Document)
        .where(
            Document.application_id == application.id,
            Document.kind == DocumentKind.BANK_STATEMENT,
            Document.parsed.is_not(None),
        )
        .order_by(Document.created_at.desc())
    ).first()
    return document.parsed if document else None


def collect_inputs(db: Session, application: Application, today: date | None = None) -> Features:
    steps = run_results(db, application)

    def result(code: StepCode) -> dict[str, Any] | None:
        row = steps.get(code)
        return row.result if row and row.status in (StepStatus.DONE, StepStatus.SKIPPED) else None

    unavailable = [code for code, row in steps.items() if code in EXTERNAL_STEPS and row.status == StepStatus.FAILED]
    return build_features(
        today=today or now().date(),
        amount=Decimal(application.amount),
        term_months=application.term_months,
        declared_revenue=Decimal(application.declared_revenue) if application.declared_revenue else None,
        egrul=result(StepCode.EGRUL),
        fns=result(StepCode.FNS),
        girbo=result(StepCode.GIRBO),
        bki=result(StepCode.BKI),
        bank=result(StepCode.BANK),
        statement=latest_statement(db, application),
        unavailable_sources=unavailable,
    )


# ---------------------------------------------------------------- шаги


def data_check(db: Session, application: Application) -> StepOutcome:
    product = application.product
    consents = {c.kind for c in db.scalars(select(Consent).where(Consent.application_id == application.id))}
    checks = [
        {"title": "ИНН корректен", "ok": is_valid_inn(application.company.inn)},
        {"title": "Продукт доступен", "ok": product.active},
        {"title": "Сумма в пределах продукта", "ok": product.min_amount <= application.amount <= product.max_amount},
        {"title": "Срок в пределах продукта", "ok": product.min_term <= application.term_months <= product.max_term},
        {"title": "Согласие на запрос в БКИ", "ok": ConsentType.BKI in consents},
        {"title": "Согласие на обработку персональных данных", "ok": ConsentType.PD in consents},
    ]
    if product.collateral_required:
        checks.append({"title": "Указан залог", "ok": bool(application.collateral_value)})
    failed = [c["title"] for c in checks if not c["ok"]]
    if failed:
        transition(
            db,
            application,
            AppStatus.MANUAL_REVIEW,
            actor=Actor.SYSTEM,
            reason="Данные заявки требуют проверки: " + ", ".join(failed),
        )
        return StepOutcome(StepStatus.DONE, {"checks": checks, "stopped": True})
    return StepOutcome(StepStatus.DONE, {"checks": checks})


def egrul(db: Session, application: Application) -> StepOutcome:
    company: Company = application.company
    try:
        data = external_systems().egrul(company.inn)
    except SourceNotFound:
        transition(
            db, application, AppStatus.MANUAL_REVIEW, actor=Actor.SYSTEM, reason="Компания не найдена в ЕГРЮЛ / ЕГРИП"
        )
        return StepOutcome(StepStatus.DONE, {"found": False, "stopped": True})
    company.name = data["name"]
    company.legal_form = data["legal_form"]
    company.ogrn = data["ogrn"]
    company.registration_date = date.fromisoformat(data["registration_date"])
    company.okved = data["okved"]
    company.okved_name = data["okved_name"]
    company.address = data["address"]
    company.status = data["status"]
    company.director_name = data["director"]["name"]
    company.registry_synced_at = now()
    return StepOutcome(StepStatus.DONE, {"found": True, **data})


def fns(db: Session, application: Application) -> StepOutcome:
    return StepOutcome(StepStatus.DONE, external_systems().fns(application.company.inn))


def girbo(db: Session, application: Application) -> StepOutcome:
    if application.company.legal_form == "IP":
        return StepOutcome(
            StepStatus.SKIPPED,
            {"available": False, "reason": "Индивидуальные предприниматели не сдают бухгалтерскую отчётность"},
        )
    data = external_systems().girbo(application.company.inn)
    return StepOutcome(StepStatus.DONE if data.get("available") else StepStatus.SKIPPED, data)


def bki(db: Session, application: Application) -> StepOutcome:
    consent = db.scalars(
        select(Consent).where(Consent.application_id == application.id, Consent.kind == ConsentType.BKI)
    ).first()
    data = external_systems().bki(application.company.inn, str(consent.id) if consent else "")
    return StepOutcome(StepStatus.DONE, data)


def bank(db: Session, application: Application) -> StepOutcome:
    data = external_systems().bank(application.company.inn)
    application.company.is_bank_client = bool(data.get("is_client"))
    opened = data.get("account_opened_at")
    application.company.bank_account_opened_at = date.fromisoformat(opened) if opened else None
    return StepOutcome(StepStatus.DONE if data.get("is_client") else StepStatus.SKIPPED, data)


def scoring(db: Session, application: Application) -> StepOutcome:
    features = collect_inputs(db, application)
    result = score(features)
    db.add(
        ScoringResult(
            application_id=application.id,
            run_no=application.run_no,
            scoring_version=SCORING_VERSION,
            score=result.score,
            risk_class=result.risk_class,
            pd=result.pd,
            features=features.to_dict(),
            factors=[f.to_dict() for f in result.factors],
        )
    )
    return StepOutcome(
        StepStatus.DONE, {"score": result.score, "risk_class": result.risk_class, "version": SCORING_VERSION}
    )


def save_decision(
    db: Session,
    application: Application,
    d: PolicyDecision,
    *,
    kind: DecisionKind,
    user: User | None = None,
    comment: str | None = None,
) -> Decision:
    DECISIONS.labels(kind=kind.value, outcome=d.outcome.value).inc()
    decision = Decision(
        application_id=application.id,
        run_no=application.run_no,
        kind=kind,
        outcome=d.outcome,
        policy_version=d.policy_version,
        limit_amount=d.limit,
        limit_binding=d.limit_binding,
        product_code=application.product_code,
        rate=d.rate,
        stop_factors=d.stop_factors,
        flags=d.flags,
        reason_codes=d.reason_codes,
        trace=d.trace,
        comment=comment,
        decided_by=user.id if user else None,
    )
    db.add(decision)
    db.flush()
    return decision


def create_offers(db: Session, application: Application, decision: Decision, d: PolicyDecision) -> None:
    valid_until = now() + timedelta(hours=get_settings().offer_ttl_hours)
    for no, option in enumerate(d.options, start=1):
        db.add(
            Offer(
                application_id=application.id,
                decision_id=decision.id,
                option_no=no,
                kind=option.kind,
                product_code=option.product_code,
                amount=option.amount,
                term_months=option.term_months,
                rate=option.rate,
                monthly_payment=option.monthly_payment,
                overpayment=option.overpayment,
                valid_until=valid_until,
                status=OfferStatus.ACTIVE,
                note=option.note,
            )
        )


def policy(db: Session, application: Application) -> StepOutcome:
    features = collect_inputs(db, application)
    result: ScoreResult = score(features)
    product = ProductTerms.from_model(application.product)
    d = decide(
        product,
        features,
        result,
        amount=Decimal(application.amount),
        term_months=application.term_months,
        collateral_value=Decimal(application.collateral_value) if application.collateral_value else None,
    )
    decision = save_decision(db, application, d, kind=DecisionKind.AUTO)

    if d.outcome == Outcome.REJECT:
        transition(
            db, application, AppStatus.REJECTED, actor=Actor.SYSTEM, reason=", ".join(d.stop_factors + d.reason_codes)
        )
    elif d.outcome == Outcome.NEED_INFO:
        db.add(
            InfoRequest(
                application_id=application.id,
                origin=InfoOrigin.SYSTEM,
                items=d.info_items,
                comment="Чтобы оценить выручку, нам не хватает данных о поступлениях на счёт.",
                due_at=now() + timedelta(hours=get_settings().info_request_ttl_hours),
            )
        )
        transition(db, application, AppStatus.NEED_INFO, actor=Actor.SYSTEM, reason="Нет данных о выручке")
    elif d.outcome == Outcome.MANUAL_REVIEW:
        reason = ", ".join(f"{code} {FLAGS[code]}" for code in d.flags) or "Продукт рассматривает аналитик"
        transition(db, application, AppStatus.MANUAL_REVIEW, actor=Actor.SYSTEM, reason=reason)
    else:
        create_offers(db, application, decision, d)
        transition(
            db,
            application,
            AppStatus.OFFER,
            actor=Actor.SYSTEM,
            reason="Одобрено автоматически" if d.outcome == Outcome.APPROVE else "Контрпредложение",
        )
    return StepOutcome(
        StepStatus.DONE,
        {
            "outcome": d.outcome,
            "limit": float(d.limit) if d.limit else None,
            "flags": d.flags,
            "stop_factors": d.stop_factors,
            "version": POLICY_VERSION,
        },
    )


HANDLERS = {
    StepCode.DATA_CHECK: data_check,
    StepCode.EGRUL: egrul,
    StepCode.FNS: fns,
    StepCode.GIRBO: girbo,
    StepCode.BKI: bki,
    StepCode.BANK: bank,
    StepCode.SCORING: scoring,
    StepCode.POLICY: policy,
}


def retry_delay(attempts: int) -> float:
    settings = get_settings()
    return min(settings.retry_base_seconds * 2 ** max(attempts - 1, 0), settings.retry_max_seconds)


def run_pipeline_step(db: Session, job: Job) -> None:
    application = db.get(Application, job.application_id, with_for_update=True)
    run_no, code = job.payload["run_no"], StepCode(job.payload["step"])
    if application is None or run_no != application.run_no:
        queue.finish(db, job)
        return
    if application.status == AppStatus.SUBMITTED:
        transition(db, application, AppStatus.IN_PROCESSING, actor=Actor.SYSTEM)
    if application.status != AppStatus.IN_PROCESSING:
        queue.finish(db, job)
        return

    row = step_row(db, application, run_no, code)
    row.status = StepStatus.RUNNING
    row.started_at = row.started_at or now()
    row.attempts += 1
    try:
        outcome = HANDLERS[code](db, application)
    except SourceUnavailable as error:
        handle_unavailable(db, application, row, job, str(error))
        return

    row.status = outcome.status
    row.result = outcome.result
    STEPS.labels(step=code.value, status=outcome.status.value).inc()
    row.error = None
    row.next_retry_at = None
    row.finished_at = now()
    events.refresh(db, application, "PIPELINE_STEP")
    queue.finish(db, job)

    if application.status != AppStatus.IN_PROCESSING:
        return
    index = PIPELINE_ORDER.index(code)
    if index + 1 < len(PIPELINE_ORDER):
        queue.enqueue(db, JobKind.PIPELINE_STEP, application.id, {"run_no": run_no, "step": PIPELINE_ORDER[index + 1]})


def handle_unavailable(db: Session, application: Application, row: PipelineStep, job: Job, error: str) -> None:
    settings = get_settings()
    first_wait = row.waiting_since is None
    row.waiting_since = row.waiting_since or now()
    row.error = error
    waited = now() - row.waiting_since
    if waited > timedelta(minutes=settings.source_wait_limit_minutes):
        # Ждать дальше нельзя: шаг помечается как неуспешный, заявка уйдёт к аналитику с флагом F05.
        row.status = StepStatus.FAILED
        row.finished_at = now()
        STEPS.labels(step=row.step, status=StepStatus.FAILED.value).inc()
        events.emit(
            db,
            application,
            audience=Audience.BANK,
            kind="SOURCE_FAILED",
            title=f"Источник недоступен по заявке № {application.number}",
            body=f"{STEP_LABELS[row.step]['title']}: {error}",
        )
        queue.finish(db, job)
        index = PIPELINE_ORDER.index(StepCode(row.step))
        queue.enqueue(
            db, JobKind.PIPELINE_STEP, application.id, {"run_no": row.run_no, "step": PIPELINE_ORDER[index + 1]}
        )
        return
    row.status = StepStatus.WAITING
    STEPS.labels(step=row.step, status=StepStatus.WAITING.value).inc()
    delay = retry_delay(row.attempts)
    row.next_retry_at = now() + timedelta(seconds=delay)
    queue.reschedule(db, job, row.next_retry_at, error)
    if first_wait:
        events.emit(
            db,
            application,
            audience=Audience.BANK,
            kind="SOURCE_WAITING",
            title=f"Ожидание внешнего источника по заявке № {application.number}",
            body=f"{STEP_LABELS[row.step]['title']}: {error}",
            notify=False,
        )
    events.refresh(db, application, "PIPELINE_STEP")


# ---------------------------------------------------------------- после решения


def accepted_offer(db: Session, application: Application) -> Offer:
    return db.scalars(
        select(Offer).where(Offer.application_id == application.id, Offer.status == OfferStatus.ACCEPTED)
    ).one()


def generate_documents(db: Session, job: Job) -> None:
    application = db.get(Application, job.application_id, with_for_update=True)
    if application is None or application.status != AppStatus.ACCEPTED:
        queue.finish(db, job)
        return
    offer = accepted_offer(db, application)
    signer = db.get(User, application.created_by)
    pdf, _ = documents.agreement_pdf(application, offer, signer.full_name if signer else None)
    documents.store(
        db,
        application,
        file_name=f"Кредитный договор {application.number}.pdf",
        data=pdf,
        kind=DocumentKind.AGREEMENT,
        source=DocumentSource.GENERATED,
        user=None,
    )
    transition(db, application, AppStatus.SIGNING, actor=Actor.SYSTEM)
    queue.finish(db, job)


def disburse(db: Session, job: Job) -> None:
    application = db.get(Application, job.application_id, with_for_update=True)
    if application is None or application.status != AppStatus.SIGNED:
        queue.finish(db, job)
        return
    offer = accepted_offer(db, application)
    try:
        result = external_systems().disburse(
            inn=application.company.inn,
            application_number=application.number,
            amount=float(offer.amount),
            rate=float(offer.rate),
            term_months=offer.term_months,
        )
    except SourceUnavailable as error:
        queue.reschedule(db, job, now() + timedelta(seconds=retry_delay(job.attempts)), str(error))
        if job.attempts == 3:
            events.emit(
                db,
                application,
                audience=Audience.BANK,
                kind="DISBURSE_RETRY",
                title=f"Повторяем выдачу по заявке № {application.number}",
                body=str(error),
            )
        return
    issued_at = now()
    loan = Loan(
        application_id=application.id,
        offer_id=offer.id,
        product_code=offer.product_code,
        account_number=result["account_number"],
        amount=offer.amount,
        rate=offer.rate,
        term_months=offer.term_months,
        monthly_payment=offer.monthly_payment,
        issued_at=issued_at,
    )
    db.add(loan)
    db.flush()
    for row in payment_schedule(offer.amount, offer.rate, offer.term_months, issued_at.date()):
        db.add(
            ScheduleItem(
                loan_id=loan.id,
                n=row.n,
                due_date=row.due_date,
                payment=row.payment,
                principal=row.principal,
                interest=row.interest,
                balance=row.balance,
            )
        )
    transition(
        db, application, AppStatus.ISSUED, actor=Actor.SYSTEM, reason=f"Кредит выдан на счёт {result['account_number']}"
    )
    queue.finish(db, job)


JOB_HANDLERS = {
    JobKind.PIPELINE_STEP: run_pipeline_step,
    JobKind.GENERATE_DOCS: generate_documents,
    JobKind.DISBURSE: disburse,
}
