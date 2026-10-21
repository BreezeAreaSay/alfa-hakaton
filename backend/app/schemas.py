"""Схемы запросов и ответов API. По ним строится OpenAPI (docs/api/openapi.json)."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.enums import Purpose


class Model(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- пользователи и компании


class CompanyOut(Model):
    id: uuid.UUID
    inn: str
    name: str
    legal_form: str | None
    ogrn: str | None
    registration_date: date | None
    okved: str | None
    okved_name: str | None
    address: str | None
    status: str | None
    status_label: str | None = None
    director_name: str | None
    is_bank_client: bool
    bank_account_opened_at: date | None
    business_months: int | None = None
    account_months: int | None = None
    registry_synced_at: datetime | None


class UserOut(Model):
    id: uuid.UUID
    login: str
    full_name: str
    position: str | None
    role: str
    can_sign: bool
    company: CompanyOut | None = None


class LoginRequest(BaseModel):
    login: str = Field(examples=["veter"])
    password: str = Field(examples=["demo"])


class LoginResponse(BaseModel):
    token: str
    user: UserOut


# ---------------------------------------------------------------- каталог


class ProductOut(Model):
    code: str
    name: str
    kind: str
    description: str
    min_amount: Decimal
    max_amount: Decimal
    min_term: int
    max_term: int
    base_rate: Decimal
    collateral_required: bool
    min_business_months: int
    max_business_months: int | None
    requires_bank_account_months: int | None
    auto_limit: Decimal | None


class QuoteRequest(BaseModel):
    purpose: Purpose
    amount: Decimal = Field(gt=0, examples=[3000000])
    term_months: int = Field(gt=0, le=240, examples=[24])
    legal_form: Literal["OOO", "IP"] | None = None
    business_months: int | None = Field(default=None, ge=0)
    is_bank_client: bool = False
    account_months: int = Field(default=0, ge=0)


class QuoteItem(BaseModel):
    product: ProductOut
    eligible: bool
    issues: list[str]
    rate_from: Decimal
    monthly_payment: Decimal
    overpayment: Decimal
    payment_label: str


# ---------------------------------------------------------------- заявка


class ApplicationCreate(BaseModel):
    product_code: str
    purpose: Purpose
    purpose_text: str | None = Field(default=None, max_length=500)
    amount: Decimal = Field(gt=0)
    term_months: int = Field(gt=0, le=240)
    declared_revenue: Decimal | None = Field(default=None, ge=0)
    collateral_type: str | None = Field(default=None, max_length=64)
    collateral_value: Decimal | None = Field(default=None, ge=0)
    ai_parsed: dict[str, Any] | None = None


class ApplicationUpdate(BaseModel):
    product_code: str | None = None
    purpose: Purpose | None = None
    purpose_text: str | None = Field(default=None, max_length=500)
    amount: Decimal | None = Field(default=None, gt=0)
    term_months: int | None = Field(default=None, gt=0, le=240)
    declared_revenue: Decimal | None = Field(default=None, ge=0)
    collateral_type: str | None = Field(default=None, max_length=64)
    collateral_value: Decimal | None = Field(default=None, ge=0)


class SubmitRequest(BaseModel):
    consent_bki: bool
    consent_pd: bool


class StepOut(BaseModel):
    step: str
    title: str
    status: str
    attempts: int
    started_at: datetime | None
    finished_at: datetime | None
    next_retry_at: datetime | None
    waiting_text: str | None
    error: str | None = None


class OfferOut(Model):
    id: uuid.UUID
    option_no: int
    kind: str
    product_code: str
    product_name: str
    product_kind: str
    amount: Decimal
    term_months: int
    rate: Decimal
    monthly_payment: Decimal
    overpayment: Decimal
    payment_label: str
    valid_until: datetime
    status: str
    note: str | None


class InfoRequestOut(Model):
    id: uuid.UUID
    origin: str
    items: list[dict[str, Any]]
    comment: str | None
    due_at: datetime
    status: str
    answer_text: str | None
    answered_at: datetime | None
    created_at: datetime


class DocumentOut(Model):
    id: uuid.UUID
    kind: str
    kind_label: str
    source: str
    file_name: str
    content_type: str
    size: int
    sha256: str
    created_at: datetime
    info_request_id: uuid.UUID | None
    parsed: dict[str, Any] | None = None
    signed_by_client: bool = False
    signed_by_bank: bool = False


class HistoryOut(BaseModel):
    from_status: str | None
    to_status: str
    to_label: str
    actor: str
    actor_name: str | None
    reason: str | None
    created_at: datetime


class ExplanationOut(BaseModel):
    positive: list[str] = []
    negative: list[str] = []
    limit_phrase: str | None = None
    rejection: list[str] = []
    advice: list[str] = []


class ScheduleItemOut(Model):
    n: int
    due_date: date
    payment: Decimal
    principal: Decimal
    interest: Decimal
    balance: Decimal


class LoanOut(Model):
    id: uuid.UUID
    product_code: str
    account_number: str
    amount: Decimal
    rate: Decimal
    term_months: int
    monthly_payment: Decimal
    issued_at: datetime
    schedule: list[ScheduleItemOut]


class ApplicationListItem(BaseModel):
    id: uuid.UUID
    number: str
    status: str
    status_label: str
    product_code: str
    product_name: str
    amount: Decimal
    term_months: int
    created_at: datetime
    status_changed_at: datetime
    needs_action: bool


class ApplicationOut(BaseModel):
    id: uuid.UUID
    number: str
    status: str
    status_label: str
    next_step: str
    needs_action: bool
    can_cancel: bool
    product: ProductOut
    purpose: str
    purpose_label: str
    purpose_text: str | None
    amount: Decimal
    term_months: int
    declared_revenue: Decimal | None
    collateral_type: str | None
    collateral_value: Decimal | None
    created_at: datetime
    submitted_at: datetime | None
    status_changed_at: datetime
    closed_at: datetime | None
    run_no: int
    company: CompanyOut
    steps: list[StepOut]
    offers: list[OfferOut]
    info_requests: list[InfoRequestOut]
    documents: list[DocumentOut]
    history: list[HistoryOut]
    explanation: ExplanationOut
    loan: LoanOut | None
    ai_parsed: dict[str, Any] | None = None


class InfoAnswer(BaseModel):
    """Ответ на запрос банка. Файлы прикладываются заранее загрузкой документа с info_request_id."""

    text: str | None = Field(default=None, max_length=4000)


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class MessageOut(BaseModel):
    id: int
    author_name: str
    author_role: str
    text: str
    created_at: datetime


class SignRequest(BaseModel):
    password: str


# ---------------------------------------------------------------- уведомления


class NotificationOut(BaseModel):
    id: int
    application_id: uuid.UUID | None
    kind: str
    title: str
    body: str | None
    created_at: datetime
    unread: bool


class NotificationsOut(BaseModel):
    unread: int
    items: list[NotificationOut]


# ---------------------------------------------------------------- банк


class QueueItem(BaseModel):
    id: uuid.UUID
    number: str
    company_name: str
    inn: str
    legal_form: str | None
    product_code: str
    product_name: str
    amount: Decimal
    term_months: int
    status: str
    status_label: str
    risk_class: str | None
    score: int | None
    flags: list[str]
    assignee_name: str | None
    assignee_is_me: bool
    sla_due_at: datetime | None
    overdue: bool
    submitted_at: datetime | None
    status_changed_at: datetime
    waiting_source: str | None


class BankSummary(BaseModel):
    manual_review: int
    mine: int
    overdue: int
    need_info: int
    in_processing: int
    waiting_sources: int
    offers: int
    issued_today: int


class DecisionRequest(BaseModel):
    action: Literal["APPROVE", "COUNTER", "REJECT"]
    product_code: str | None = None
    amount: Decimal | None = Field(default=None, gt=0)
    term_months: int | None = Field(default=None, gt=0, le=240)
    rate: Decimal | None = Field(default=None, gt=0, le=60)
    reason_code: Literal["R01", "R02", "R03", "R04", "R05", "R06", "R07"] | None = None
    comment: str | None = Field(default=None, max_length=2000)


class InfoRequestCreate(BaseModel):
    items: list[str] = Field(min_length=1)
    comment: str | None = Field(default=None, max_length=2000)
    due_hours: int = Field(default=72, ge=1, le=24 * 30)


class TermsPreviewRequest(BaseModel):
    product_code: str
    amount: Decimal = Field(gt=0)
    term_months: int = Field(gt=0, le=240)
    rate: Decimal | None = None


class TermsPreview(BaseModel):
    limit: Decimal | None
    limit_binding: str | None
    limit_phrase: str | None
    min_rate: Decimal | None
    rate: Decimal | None
    monthly_payment: Decimal | None
    overpayment: Decimal | None
    payment_label: str
    errors: list[str]
    constraints: list[dict[str, Any]]


class FaultIn(BaseModel):
    mode: Literal["ok", "error", "timeout", "slow"]
    latency_ms: int = Field(default=0, ge=0, le=20000)
