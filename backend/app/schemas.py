"""Схемы запросов и ответов API. По ним строится OpenAPI (docs/api/openapi.json)."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

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


class ProactiveOffer(BaseModel):
    product_code: str
    product_name: str
    kind: str
    purpose: Purpose
    amount: float
    term_months: int
    rate_from: float
    monthly_payment: float
    payment_label: str


class ProactiveOffers(BaseModel):
    """Предварительные предложения на главной: по ЕГРЮЛ, отчётности и оборотам, без кредитной истории и заявки."""

    offers: list[ProactiveOffer]
    facts: list[str]
    note: str | None
    computed_at: datetime


# ---------------------------------------------------------------- заявка


class PreliminaryOffers(ProactiveOffers):
    """Предварительный лимит по выписке без заявки: предложения, на чём основаны, и разбор выписки с прогнозом."""

    statement: dict[str, Any]


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
    """Изменение черновика: передаются только меняемые поля. Обязательные поля нельзя очистить — null даёт 422."""

    product_code: str = None
    purpose: Purpose = None
    purpose_text: str | None = Field(default=None, max_length=500)
    amount: Decimal = Field(default=None, gt=0)
    term_months: int = Field(default=None, gt=0, le=240)
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


class RateBreakdownOut(BaseModel):
    """Из чего складывается ставка предложения, в процентных пунктах."""

    key_rate: Decimal
    product_spread: Decimal
    risk_margin: Decimal
    adjustment: Decimal
    rate: Decimal


class RateHintOut(BaseModel):
    kind: str  # product — более дешёвый продукт, risk — что снизит надбавку за риск
    text: str
    product_code: str | None = None
    product_name: str | None = None
    rate: Decimal | None = None
    saving: Decimal | None = None  # на сколько меньше переплата при той же сумме и сроке


class AlternativeOut(BaseModel):
    """«Вам может подойти» после отказа: продукт, доступная сумма, срок и ставка для этой компании."""

    product_code: str
    product_name: str
    max_amount: Decimal
    term_months: int
    rate: Decimal


class ExplanationOut(BaseModel):
    positive: list[str] = []
    negative: list[str] = []
    limit_phrase: str | None = None
    rejection: list[str] = []
    advice: list[str] = []
    next_steps: list[str] = []
    rate_breakdown: RateBreakdownOut | None = None
    rate_hints: list[RateHintOut] = []
    alternatives: list[AlternativeOut] = []


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
    sla_due_at: datetime | None = None
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


class MetricCount(BaseModel):
    code: str
    title: str
    count: int


class ProductMetrics(BaseModel):
    code: str
    name: str
    applications: int = 0
    approved: int = 0
    issued: int = 0
    issued_amount: Decimal = Decimal(0)


class AnalystMetrics(BaseModel):
    name: str
    decided: int
    in_work: int
    overdue: int
    median_review_hours: float | None


class DailyMetrics(BaseModel):
    date: date
    submitted: int = 0
    decided: int = 0
    issued: int = 0


class BankMetrics(BaseModel):
    """Показатели конвейера за период по заявкам, поданным за этот период (docs/product.md, «Как измерять успех»)."""

    period_days: int
    since: datetime
    until: datetime
    submitted: int
    in_progress: int
    decided: int
    auto_decided: int
    manual_decided: int
    automation_share: float | None
    manual_review: int
    need_info: int
    issued: int
    issued_amount: Decimal
    outcomes: list[MetricCount]
    to_decision_median_seconds: float | None
    to_decision_p95_seconds: float | None
    to_issue_median_hours: float | None
    info_response_median_hours: float | None
    review_median_hours: float | None
    offered: int
    accepted: int
    offer_conversion: float | None
    counter_offered: int
    counter_accepted: int
    counter_conversion: float | None
    sla_overdue_now: int
    sla_breached: int
    rejection_reasons: list[MetricCount]
    products: list[ProductMetrics]
    analysts: list[AnalystMetrics]
    daily: list[DailyMetrics]


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


# ---------------------------------------------------------------- конструктор тестовой компании

# Коды ОКВЭД, из которых выбирает администратор: те же, что у тестовых компаний. По первым двум цифрам
# считаются отраслевой риск и типичная рентабельность (app/domain/features.py).
COMPANY_BUILDER_OKVED: dict[str, str] = {
    "25.11": "Производство строительных металлических конструкций",
    "41.20": "Строительство жилых и нежилых зданий",
    "46.39": "Торговля оптовая неспециализированная пищевыми продуктами",
    "47.19": "Торговля розничная прочая в неспециализированных магазинах",
    "49.41": "Деятельность автомобильного грузового транспорта",
    "56.30": "Подача напитков",
    "62.01": "Разработка компьютерного программного обеспечения",
    "62.02": "Деятельность консультативная в области компьютерных технологий",
    "74.10": "Деятельность специализированная в области дизайна",
}


def _reject(message: str) -> PydanticCustomError:
    """Ошибка проверки с понятным русским текстом: в ответе 422 он попадает в msg без префикса."""
    return PydanticCustomError("value_error", message)


def _within(value: int | float, low: int | float, high: int | float, message: str) -> None:
    if not low <= value <= high:
        raise _reject(message)


class OkvedOption(BaseModel):
    code: str
    name: str
    industry_risk: Literal["LOW", "MEDIUM", "HIGH"]
    typical_margin: float


class CompanyBuilderOptions(BaseModel):
    """Справочники для формы конструктора: коды ОКВЭД с отраслевым риском и типичной рентабельностью."""

    okved: list[OkvedOption]


class CompanyBuilderIn(BaseModel):
    """Своя тестовая компания: по этим параметрам симулятор создаёт данные во всех внешних системах,
    а в базе появляются компания и пользователь-клиент (docs/data-model.md, «Как добавить свою компанию»).
    Исход заявки не задаётся — его считает конвейер по общим правилам скоринга и политики."""

    name: str = Field(
        examples=["Белые ночи"],
        description="Название без организационно-правовой формы; для ИП — фамилия, имя и отчество предпринимателя",
    )
    legal_form: Literal["OOO", "IP"] = "OOO"
    registered_months_ago: int = Field(default=72, description="Сколько месяцев назад зарегистрирована")
    okved: str = Field(default="46.39", description="Код ОКВЭД из справочника GET /api/admin/companies/options")
    revenue: int = Field(default=60_000_000, description="Выручка за последний год, ₽")
    revenue_growth: float = Field(default=0.12, description="Рост выручки к предыдущему году, доля: 0.1 — рост на 10 %")
    margin: float = Field(default=0.1, description="Рентабельность продаж, доля: 0.08 — 8 %")
    existing_monthly_payments: int = Field(
        default=0, description="Платежи по действующим кредитам в месяц, ₽; 0 — кредитов нет"
    )
    max_overdue_days_24m: int = Field(default=0, description="Максимальная просрочка за 24 месяца, дней")
    current_overdue_days: int = Field(default=0, description="Текущая просрочка, дней")
    tax_debt: int = Field(default=0, description="Налоговая задолженность, ₽")
    mass_address: bool = Field(default=False, description="Адрес массовой регистрации")
    director_disqualified: bool = Field(default=False, description="Руководитель дисквалифицирован")
    company_status: Literal["ACTIVE", "LIQUIDATING"] = "ACTIVE"
    is_bank_client: bool = True
    account_months: int = Field(default=36, description="Сколько месяцев открыт счёт в банке")
    avg_monthly_inflow: int = Field(
        default=5_000_000, description="Среднемесячные поступления на счёт, ₽ — для клиента банка"
    )

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise _reject("Укажите название компании")
        if len(value) > 120:
            raise _reject("Название не длиннее 120 символов")
        return value

    @field_validator("registered_months_ago")
    @classmethod
    def _registered(cls, value: int) -> int:
        _within(value, 0, 600, "Срок с регистрации — от 0 до 600 месяцев")
        return value

    @field_validator("okved")
    @classmethod
    def _okved(cls, value: str) -> str:
        if value not in COMPANY_BUILDER_OKVED:
            raise _reject("Неизвестный код ОКВЭД — выберите из справочника")
        return value

    @field_validator("revenue")
    @classmethod
    def _revenue(cls, value: int) -> int:
        _within(value, 1, 1_000_000_000_000, "Выручка — от 1 ₽ до 1 трлн ₽")
        return value

    @field_validator("revenue_growth")
    @classmethod
    def _growth(cls, value: float) -> float:
        _within(value, -0.9, 10, "Рост выручки — доля от −0,9 до 10: например, 0,1 — рост на 10 %")
        return value

    @field_validator("margin")
    @classmethod
    def _margin(cls, value: float) -> float:
        _within(value, -1, 1, "Рентабельность — доля от −1 до 1: например, 0,08 — 8 %")
        return value

    @field_validator("existing_monthly_payments")
    @classmethod
    def _payments(cls, value: int) -> int:
        _within(value, 0, 1_000_000_000, "Платежи по кредитам — от 0 до 1 млрд ₽ в месяц")
        return value

    @field_validator("max_overdue_days_24m", "current_overdue_days")
    @classmethod
    def _overdue(cls, value: int) -> int:
        _within(value, 0, 730, "Дни просрочки — от 0 до 730")
        return value

    @field_validator("tax_debt")
    @classmethod
    def _tax_debt(cls, value: int) -> int:
        _within(value, 0, 10_000_000_000, "Налоговая задолженность — от 0 до 10 млрд ₽")
        return value

    @field_validator("account_months")
    @classmethod
    def _account_months(cls, value: int) -> int:
        _within(value, 0, 600, "Срок счёта — от 0 до 600 месяцев")
        return value

    @field_validator("avg_monthly_inflow")
    @classmethod
    def _inflow(cls, value: int) -> int:
        _within(value, 0, 100_000_000_000, "Поступления на счёт — от 0 до 100 млрд ₽ в месяц")
        return value

    @model_validator(mode="after")
    def _consistent(self) -> "CompanyBuilderIn":
        if self.current_overdue_days > self.max_overdue_days_24m:
            raise _reject("Максимальная просрочка за 24 месяца не может быть меньше текущей")
        if not self.is_bank_client:
            # Не клиент банка: счёта и поступлений нет, что бы ни пришло в этих полях
            self.account_months = 0
            self.avg_monthly_inflow = 0
            return self
        if self.account_months > self.registered_months_ago:
            raise _reject("Счёт в банке не может быть открыт раньше регистрации компании")
        if self.avg_monthly_inflow <= 0:
            raise _reject("Для клиента банка укажите среднемесячные поступления на счёт")
        return self


class CompanyBuilderOut(BaseModel):
    """Созданная компания и учётная запись её руководителя: пароль у всех демо-пользователей один."""

    login: str
    password: str
    company: CompanyOut
    inn: str
