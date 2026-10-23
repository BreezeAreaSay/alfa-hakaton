import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Sequence,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

Json = JSON().with_variant(JSONB(), "postgresql")
Money = Numeric(15, 2)


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Company(TimestampMixin, Base):
    __tablename__ = "companies"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    inn: Mapped[str] = mapped_column(String(12), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    legal_form: Mapped[str | None] = mapped_column(String(8))
    ogrn: Mapped[str | None] = mapped_column(String(15))
    registration_date: Mapped[date | None] = mapped_column(Date)
    okved: Mapped[str | None] = mapped_column(String(16))
    okved_name: Mapped[str | None] = mapped_column(String(255))
    address: Mapped[str | None] = mapped_column(String(512))
    status: Mapped[str | None] = mapped_column(String(32))
    director_name: Mapped[str | None] = mapped_column(String(255))
    is_bank_client: Mapped[bool] = mapped_column(Boolean, default=False)
    bank_account_opened_at: Mapped[date | None] = mapped_column(Date)
    registry_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    login: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    full_name: Mapped[str] = mapped_column(String(255))
    position: Mapped[str | None] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(16))
    company_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("companies.id"))
    can_sign: Mapped[bool] = mapped_column(Boolean, default=False)
    last_read_event_id: Mapped[int] = mapped_column(BigInteger, default=0)

    company: Mapped[Company | None] = relationship()


class Product(Base):
    __tablename__ = "products"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text)
    min_amount: Mapped[Decimal] = mapped_column(Money)
    max_amount: Mapped[Decimal] = mapped_column(Money)
    min_term: Mapped[int] = mapped_column(Integer)
    max_term: Mapped[int] = mapped_column(Integer)
    base_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    collateral_required: Mapped[bool] = mapped_column(Boolean, default=False)
    min_business_months: Mapped[int] = mapped_column(Integer, default=0)
    max_business_months: Mapped[int | None] = mapped_column(Integer)
    requires_bank_account_months: Mapped[int | None] = mapped_column(Integer)
    auto_limit: Mapped[Decimal | None] = mapped_column(Money)
    always_manual: Mapped[bool] = mapped_column(Boolean, default=False)
    purposes: Mapped[list[str]] = mapped_column(Json, default=list)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


application_number_seq = Sequence("application_number_seq", start=1, metadata=Base.metadata)


class Application(TimestampMixin, Base):
    __tablename__ = "applications"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    company_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("companies.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    product_code: Mapped[str] = mapped_column(ForeignKey("products.code"))
    purpose: Mapped[str] = mapped_column(String(32))
    purpose_text: Mapped[str | None] = mapped_column(Text)
    amount: Mapped[Decimal] = mapped_column(Money)
    term_months: Mapped[int] = mapped_column(Integer)
    declared_revenue: Mapped[Decimal | None] = mapped_column(Money)
    collateral_type: Mapped[str | None] = mapped_column(String(64))
    collateral_value: Mapped[Decimal | None] = mapped_column(Money)
    contact_name: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), index=True)
    status_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    run_no: Mapped[int] = mapped_column(Integer, default=0)
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    sla_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ai_parsed: Mapped[dict[str, Any] | None] = mapped_column(Json)
    version: Mapped[int] = mapped_column(Integer, default=1)

    __mapper_args__ = {"version_id_col": version}

    company: Mapped[Company] = relationship()
    product: Mapped[Product] = relationship()
    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_id])


class StatusHistory(TimestampMixin, Base):
    __tablename__ = "status_history"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    from_status: Mapped[str | None] = mapped_column(String(32))
    to_status: Mapped[str] = mapped_column(String(32))
    actor: Mapped[str] = mapped_column(String(16))
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reason: Mapped[str | None] = mapped_column(Text)


class Consent(TimestampMixin, Base):
    __tablename__ = "consents"
    __table_args__ = (UniqueConstraint("application_id", "kind"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    kind: Mapped[str] = mapped_column(String(8))
    given_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    text_version: Mapped[str] = mapped_column(String(16))


class PipelineStep(Base):
    __tablename__ = "pipeline_steps"
    __table_args__ = (UniqueConstraint("application_id", "run_no", "step"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    run_no: Mapped[int] = mapped_column(Integer)
    step: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    waiting_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result: Mapped[dict[str, Any] | None] = mapped_column(Json)
    error: Mapped[str | None] = mapped_column(Text)


class Job(TimestampMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_ready", "status", "run_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(32))
    application_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("applications.id"), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(Json, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="QUEUED")
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    locked_by: Mapped[str | None] = mapped_column(String(64))
    last_error: Mapped[str | None] = mapped_column(Text)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ScoringResult(TimestampMixin, Base):
    __tablename__ = "scoring_results"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    run_no: Mapped[int] = mapped_column(Integer)
    scoring_version: Mapped[str] = mapped_column(String(16))
    score: Mapped[int] = mapped_column(Integer)
    risk_class: Mapped[str] = mapped_column(String(1))
    pd: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    features: Mapped[dict[str, Any]] = mapped_column(Json)
    factors: Mapped[list[dict[str, Any]]] = mapped_column(Json)


class Decision(TimestampMixin, Base):
    __tablename__ = "decisions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    run_no: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(8))
    outcome: Mapped[str] = mapped_column(String(16))
    policy_version: Mapped[str] = mapped_column(String(16))
    limit_amount: Mapped[Decimal | None] = mapped_column(Money)
    limit_binding: Mapped[str | None] = mapped_column(String(16))
    product_code: Mapped[str | None] = mapped_column(String(32))
    rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    stop_factors: Mapped[list[str]] = mapped_column(Json, default=list)
    flags: Mapped[list[str]] = mapped_column(Json, default=list)
    reason_codes: Mapped[list[str]] = mapped_column(Json, default=list)
    trace: Mapped[list[dict[str, Any]]] = mapped_column(Json, default=list)
    comment: Mapped[str | None] = mapped_column(Text)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))


class Offer(TimestampMixin, Base):
    __tablename__ = "offers"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    decision_id: Mapped[int] = mapped_column(ForeignKey("decisions.id"))
    option_no: Mapped[int] = mapped_column(Integer, default=1)
    kind: Mapped[str] = mapped_column(String(16))
    product_code: Mapped[str] = mapped_column(ForeignKey("products.code"))
    amount: Mapped[Decimal] = mapped_column(Money)
    term_months: Mapped[int] = mapped_column(Integer)
    rate: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    monthly_payment: Mapped[Decimal] = mapped_column(Money)
    overpayment: Mapped[Decimal] = mapped_column(Money)
    valid_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="ACTIVE")
    note: Mapped[str | None] = mapped_column(Text)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    product: Mapped[Product] = relationship()


class InfoRequest(TimestampMixin, Base):
    __tablename__ = "info_requests"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    origin: Mapped[str] = mapped_column(String(16))
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    items: Mapped[list[dict[str, Any]]] = mapped_column(Json)
    comment: Mapped[str | None] = mapped_column(Text)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="OPEN")
    answer_text: Mapped[str | None] = mapped_column(Text)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Document(TimestampMixin, Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    source: Mapped[str] = mapped_column(String(16))
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(128))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(512))
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    info_request_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("info_requests.id"))
    parsed: Mapped[dict[str, Any] | None] = mapped_column(Json)


class Signature(TimestampMixin, Base):
    __tablename__ = "signatures"
    __table_args__ = (UniqueConstraint("document_id", "signer_role"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id"))
    signer_role: Mapped[str] = mapped_column(String(16))
    signer_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    method: Mapped[str] = mapped_column(String(32))
    document_sha256: Mapped[str] = mapped_column(String(64))


class Loan(TimestampMixin, Base):
    __tablename__ = "loans"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), unique=True)
    offer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("offers.id"))
    product_code: Mapped[str] = mapped_column(ForeignKey("products.code"))
    account_number: Mapped[str] = mapped_column(String(32))
    amount: Mapped[Decimal] = mapped_column(Money)
    rate: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    term_months: Mapped[int] = mapped_column(Integer)
    monthly_payment: Mapped[Decimal] = mapped_column(Money)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    schedule: Mapped[list["ScheduleItem"]] = relationship(order_by="ScheduleItem.n")


class ScheduleItem(Base):
    __tablename__ = "schedule_items"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    loan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("loans.id"), index=True)
    n: Mapped[int] = mapped_column(Integer)
    due_date: Mapped[date] = mapped_column(Date)
    payment: Mapped[Decimal] = mapped_column(Money)
    principal: Mapped[Decimal] = mapped_column(Money)
    interest: Mapped[Decimal] = mapped_column(Money)
    balance: Mapped[Decimal] = mapped_column(Money)


class Message(TimestampMixin, Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    application_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("applications.id"), index=True)
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    author_role: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)

    author: Mapped[User] = relationship()


class SupportMessage(TimestampMixin, Base):
    """Чат с поддержкой: у каждого клиента одна ветка (client_id), отвечает администратор.

    read_at — когда сообщение прочитала другая сторона; по нему считаются непрочитанные.
    """

    __tablename__ = "support_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    author_role: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    client: Mapped[User] = relationship(foreign_keys=[client_id])
    author: Mapped[User] = relationship(foreign_keys=[author_id])


class Event(TimestampMixin, Base):
    """Событие для ленты уведомлений и потока SSE."""

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    application_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("applications.id"), index=True)
    company_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("companies.id"), index=True)
    audience: Mapped[str] = mapped_column(String(8))
    kind: Mapped[str] = mapped_column(String(48))
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str | None] = mapped_column(Text)
    notify: Mapped[bool] = mapped_column(Boolean, default=True)
    payload: Mapped[dict[str, Any]] = mapped_column(Json, default=dict)


class AuditLog(TimestampMixin, Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    actor: Mapped[str] = mapped_column(String(16))
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str] = mapped_column(String(64), index=True)
    details: Mapped[dict[str, Any]] = mapped_column(Json, default=dict)
    request_id: Mapped[str | None] = mapped_column(String(64))


class IdempotencyKey(TimestampMixin, Base):
    __tablename__ = "idempotency_keys"
    __table_args__ = (UniqueConstraint("user_id", "scope", "key"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    scope: Mapped[str] = mapped_column(String(64))
    key: Mapped[str] = mapped_column(String(128))
    response: Mapped[dict[str, Any]] = mapped_column(Json)
