"""Сборка ответов API из моделей."""

from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.catalog import ProductTerms
from app.domain.enums import (
    PIPELINE_ORDER,
    AppStatus,
    DocumentKind,
    InfoStatus,
    OfferStatus,
    Role,
    StepStatus,
)
from app.domain.features import months_between
from app.domain.labels import COMPANY_STATUS_LABELS, DOCUMENT_LABELS, PURPOSE_LABELS, STATUS_LABELS, STEP_LABELS
from app.domain.policy import LIMIT_PHRASES, REASONS, REVOLVING_KINDS, STOP_FACTORS
from app.models import (
    Application,
    Company,
    Decision,
    Document,
    InfoRequest,
    Loan,
    Offer,
    PipelineStep,
    ScoringResult,
    Signature,
    StatusHistory,
    User,
)
from app.schemas import (
    ApplicationListItem,
    ApplicationOut,
    CompanyOut,
    DocumentOut,
    ExplanationOut,
    HistoryOut,
    InfoRequestOut,
    LoanOut,
    OfferOut,
    ProductOut,
    StepOut,
    UserOut,
)
from app.services.workflow import CANCELLABLE

CLIENT_ACTION_STATUSES = {AppStatus.DRAFT, AppStatus.NEED_INFO, AppStatus.OFFER, AppStatus.SIGNING}


def today() -> date:
    return datetime.now(UTC).date()


def company_out(company: Company) -> CompanyOut:
    out = CompanyOut.model_validate(company)
    out.status_label = COMPANY_STATUS_LABELS.get(company.status or "")
    if company.registration_date:
        out.business_months = months_between(company.registration_date, today())
    if company.bank_account_opened_at:
        out.account_months = months_between(company.bank_account_opened_at, today())
    return out


def user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        login=user.login,
        full_name=user.full_name,
        position=user.position,
        role=user.role,
        can_sign=user.can_sign,
        company=company_out(user.company) if user.company else None,
    )


def payment_label(kind: str) -> str:
    return "Проценты в месяц при полном использовании лимита" if kind in REVOLVING_KINDS else "Ежемесячный платёж"


def offer_out(offer: Offer) -> OfferOut:
    return OfferOut(
        id=offer.id,
        option_no=offer.option_no,
        kind=offer.kind,
        product_code=offer.product_code,
        product_name=offer.product.name,
        product_kind=offer.product.kind,
        amount=offer.amount,
        term_months=offer.term_months,
        rate=offer.rate,
        monthly_payment=offer.monthly_payment,
        overpayment=offer.overpayment,
        payment_label=payment_label(offer.product.kind),
        valid_until=offer.valid_until,
        status=offer.status,
        note=offer.note,
    )


def steps_out(db: Session, application: Application, include_errors: bool) -> list[StepOut]:
    rows = {
        row.step: row
        for row in db.scalars(
            select(PipelineStep).where(
                PipelineStep.application_id == application.id, PipelineStep.run_no == application.run_no
            )
        )
    }
    result = []
    for code in PIPELINE_ORDER:
        row = rows.get(code)
        if row is None:
            continue
        waiting = STEP_LABELS[code]["waiting"] if row.status in (StepStatus.WAITING, StepStatus.RUNNING) else None
        result.append(
            StepOut(
                step=code,
                title=STEP_LABELS[code]["title"],
                status=row.status,
                attempts=row.attempts,
                started_at=row.started_at,
                finished_at=row.finished_at,
                next_retry_at=row.next_retry_at,
                waiting_text=waiting,
                error=row.error if include_errors else None,
            )
        )
    return result


def documents_out(db: Session, application: Application) -> list[DocumentOut]:
    signatures = db.scalars(select(Signature).where(Signature.application_id == application.id)).all()
    signed = {(s.document_id, s.signer_role) for s in signatures}
    docs = db.scalars(
        select(Document).where(Document.application_id == application.id).order_by(Document.created_at)
    ).all()
    return [
        DocumentOut(
            id=d.id,
            kind=d.kind,
            kind_label=DOCUMENT_LABELS.get(d.kind, d.kind),
            source=d.source,
            file_name=d.file_name,
            content_type=d.content_type,
            size=d.size,
            sha256=d.sha256,
            created_at=d.created_at,
            info_request_id=d.info_request_id,
            parsed=d.parsed if d.kind == DocumentKind.BANK_STATEMENT else None,
            signed_by_client=(d.id, "CLIENT") in signed,
            signed_by_bank=(d.id, "BANK") in signed,
        )
        for d in docs
    ]


def history_out(db: Session, application: Application, viewer_role: str) -> list[HistoryOut]:
    rows = db.scalars(
        select(StatusHistory).where(StatusHistory.application_id == application.id).order_by(StatusHistory.id)
    ).all()
    user_ids = {r.actor_user_id for r in rows if r.actor_user_id}
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(user_ids)))} if user_ids else {}
    side = "client" if viewer_role == Role.CLIENT else "bank"
    return [
        HistoryOut(
            from_status=r.from_status,
            to_status=r.to_status,
            to_label=STATUS_LABELS[r.to_status][side],
            actor=r.actor,
            actor_name=users[r.actor_user_id].full_name if r.actor_user_id in users else None,
            reason=r.reason if viewer_role != Role.CLIENT else None,
            created_at=r.created_at,
        )
        for r in rows
    ]


def latest_scoring(db: Session, application: Application) -> ScoringResult | None:
    return db.scalars(
        select(ScoringResult).where(ScoringResult.application_id == application.id).order_by(ScoringResult.id.desc())
    ).first()


def latest_decision(db: Session, application: Application) -> Decision | None:
    return db.scalars(
        select(Decision).where(Decision.application_id == application.id).order_by(Decision.id.desc())
    ).first()


def explanation(db: Session, application: Application) -> ExplanationOut:
    """Что повлияло на решение — простыми словами (docs/credit-policy.md, «Объяснение решения клиенту»)."""
    out = ExplanationOut()
    scoring = latest_scoring(db, application)
    decision = latest_decision(db, application)
    if scoring:
        factors = scoring.factors
        positive = sorted((f for f in factors if f["points"] > 0), key=lambda f: -f["points"])
        negative = sorted((f for f in factors if f["points"] < 0), key=lambda f: f["points"])
        out.positive = [f["phrase"] for f in positive[:3]]
        out.negative = [f["phrase"] for f in negative[:2]]
    if decision:
        if decision.limit_binding and decision.outcome in ("COUNTER", "APPROVE"):
            out.limit_phrase = LIMIT_PHRASES.get(decision.limit_binding)
        if application.status == AppStatus.REJECTED:
            out.rejection = [STOP_FACTORS[code] for code in decision.stop_factors if code != "S05"]
            for code in decision.reason_codes:
                text = REASONS[code][1]
                if code == "R07" and decision.comment:
                    text = decision.comment
                out.rejection.append(text)
            if not out.rejection:
                out.rejection = [STOP_FACTORS["S05"]]
            out.advice = out.negative or []
    return out


def loan_out(db: Session, application: Application) -> LoanOut | None:
    loan = db.scalars(select(Loan).where(Loan.application_id == application.id)).first()
    return LoanOut.model_validate(loan) if loan else None


def needs_action(application: Application) -> bool:
    return application.status in CLIENT_ACTION_STATUSES


def application_out(db: Session, application: Application, viewer: User) -> ApplicationOut:
    side = "client" if viewer.role == Role.CLIENT else "bank"
    offers = db.scalars(
        select(Offer).where(Offer.application_id == application.id).order_by(Offer.created_at, Offer.option_no)
    ).all()
    if application.status == AppStatus.OFFER:
        offers = [o for o in offers if o.status == OfferStatus.ACTIVE]
    else:
        offers = [o for o in offers if o.status == OfferStatus.ACCEPTED] or (
            [o for o in offers if o.status in (OfferStatus.DECLINED, OfferStatus.EXPIRED)]
        )
    requests = db.scalars(
        select(InfoRequest).where(InfoRequest.application_id == application.id).order_by(InfoRequest.created_at)
    ).all()
    return ApplicationOut(
        id=application.id,
        number=application.number,
        status=application.status,
        status_label=STATUS_LABELS[application.status][side],
        next_step=STATUS_LABELS[application.status]["next"],
        needs_action=needs_action(application),
        can_cancel=application.status in CANCELLABLE,
        product=ProductOut.model_validate(application.product),
        purpose=application.purpose,
        purpose_label=PURPOSE_LABELS.get(application.purpose, application.purpose),
        purpose_text=application.purpose_text,
        amount=application.amount,
        term_months=application.term_months,
        declared_revenue=application.declared_revenue,
        collateral_type=application.collateral_type,
        collateral_value=application.collateral_value,
        created_at=application.created_at,
        submitted_at=application.submitted_at,
        status_changed_at=application.status_changed_at,
        closed_at=application.closed_at,
        run_no=application.run_no,
        company=company_out(application.company),
        steps=steps_out(db, application, include_errors=viewer.role != Role.CLIENT),
        offers=[offer_out(o) for o in offers],
        info_requests=[InfoRequestOut.model_validate(r) for r in requests],
        documents=documents_out(db, application),
        history=history_out(db, application, viewer.role),
        explanation=explanation(db, application),
        loan=loan_out(db, application),
        ai_parsed=application.ai_parsed,
    )


def list_item(application: Application) -> ApplicationListItem:
    return ApplicationListItem(
        id=application.id,
        number=application.number,
        status=application.status,
        status_label=STATUS_LABELS[application.status]["client"],
        product_code=application.product_code,
        product_name=application.product.name,
        amount=application.amount,
        term_months=application.term_months,
        created_at=application.created_at,
        status_changed_at=application.status_changed_at,
        needs_action=needs_action(application),
    )


def open_info_request(db: Session, application: Application) -> InfoRequest | None:
    return db.scalars(
        select(InfoRequest).where(InfoRequest.application_id == application.id, InfoRequest.status == InfoStatus.OPEN)
    ).first()


def product_terms(application: Application) -> ProductTerms:
    return ProductTerms.from_model(application.product)
