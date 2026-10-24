"""Показатели конвейера для руководителя (docs/product.md, «Как измерять успех»).

Считаются по заявкам, поданным за период: воронка, доля автоматических решений, сроки, конверсия
предложений, причины отказов, разрез по продуктам и аналитикам, динамика по дням.
"""

import statistics
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import AppStatus, DecisionKind, InfoOrigin, InfoStatus, OfferKind, OfferStatus, Outcome, Role
from app.domain.policy import REASONS
from app.domain.text import MSK
from app.models import Application, Decision, InfoRequest, Loan, Offer, Product, StatusHistory, User
from app.schemas import (
    AnalystMetrics,
    BankMetrics,
    DailyMetrics,
    MetricCount,
    ProductMetrics,
)

FINAL_OUTCOMES = {Outcome.APPROVE, Outcome.COUNTER, Outcome.REJECT}
APPROVED_OUTCOMES = {Outcome.APPROVE, Outcome.COUNTER}
OUTCOME_TITLES = {
    Outcome.APPROVE: "Одобрено как запрошено",
    Outcome.COUNTER: "Контрпредложение",
    Outcome.REJECT: "Отказ",
}
STOP_FACTOR_TITLES = {
    "S01": "Ликвидация, реорганизация или банкротство",
    "S02": "Руководитель дисквалифицирован",
    "S03": "Текущая просрочка больше 30 дней",
    "S04": "Бизнес младше 3 месяцев",
    "S05": "Класс риска E",
}


def percentile(values: list[float], share: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(share * (len(ordered) - 1)))]


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def share(part: int, whole: int) -> float | None:
    return round(part / whole, 3) if whole else None


def hours(seconds: list[float]) -> float | None:
    value = median(seconds)
    return round(value / 3600, 1) if value is not None else None


def moscow_date(moment: datetime) -> date:
    """День по московскому времени; метка без часового пояса считается UTC, как в базе."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(MSK).date()


@dataclass
class MetricsInput:
    """Данные за период. Отдельный класс, чтобы расчёт можно было проверить без базы."""

    now: datetime
    days: int
    applications: list[Application]
    decisions: list[Decision]
    offers: list[Offer]
    info_requests: list[InfoRequest]
    manual_review_history: list[StatusHistory]
    loans: list[Loan]
    analysts: list[User]
    products: dict[str, Product] = field(default_factory=dict)


def load_input(db: Session, *, days: int, now: datetime) -> MetricsInput:
    since = now - timedelta(days=days)
    applications = db.scalars(
        select(Application).where(Application.submitted_at.is_not(None), Application.submitted_at >= since)
    ).all()
    ids = [a.id for a in applications]
    if not ids:
        return MetricsInput(now, days, [], [], [], [], [], [], _analysts(db), _products(db))
    return MetricsInput(
        now=now,
        days=days,
        applications=applications,
        decisions=db.scalars(select(Decision).where(Decision.application_id.in_(ids)).order_by(Decision.id)).all(),
        offers=db.scalars(select(Offer).where(Offer.application_id.in_(ids))).all(),
        info_requests=db.scalars(select(InfoRequest).where(InfoRequest.application_id.in_(ids))).all(),
        manual_review_history=db.scalars(
            select(StatusHistory)
            .where(StatusHistory.application_id.in_(ids), StatusHistory.to_status == AppStatus.MANUAL_REVIEW)
            .order_by(StatusHistory.id)
        ).all(),
        loans=db.scalars(select(Loan).where(Loan.application_id.in_(ids))).all(),
        analysts=_analysts(db),
        products=_products(db),
    )


def _analysts(db: Session) -> list[User]:
    return db.scalars(select(User).where(User.role == Role.UNDERWRITER).order_by(User.full_name)).all()


def _products(db: Session) -> dict[str, Product]:
    return {p.code: p for p in db.scalars(select(Product).order_by(Product.sort_order))}


def compute(data: MetricsInput) -> BankMetrics:
    apps = {a.id: a for a in data.applications}
    first_final: dict[uuid.UUID, Decision] = {}
    last_final: dict[uuid.UUID, Decision] = {}
    for d in data.decisions:
        if d.outcome in FINAL_OUTCOMES:
            first_final.setdefault(d.application_id, d)
            last_final[d.application_id] = d

    decided = len(last_final)
    auto = sum(1 for d in last_final.values() if d.kind == DecisionKind.AUTO)
    went_to_review = {h.application_id for h in data.manual_review_history}
    asked_info = {r.application_id for r in data.info_requests if r.origin == InfoOrigin.SYSTEM}
    issued = [a for a in data.applications if a.status == AppStatus.ISSUED]
    loan_by_app = {loan.application_id: loan for loan in data.loans}
    issued_amount = sum((loan_by_app[a.id].amount for a in issued if a.id in loan_by_app), Decimal(0))
    active = {
        AppStatus.SUBMITTED,
        AppStatus.IN_PROCESSING,
        AppStatus.NEED_INFO,
        AppStatus.MANUAL_REVIEW,
        AppStatus.OFFER,
        AppStatus.ACCEPTED,
        AppStatus.SIGNING,
        AppStatus.SIGNED,
    }

    # Сроки: от подачи до первого окончательного решения, до выдачи, ответ клиента на запрос, рассмотрение аналитиком
    to_decision = [
        (d.created_at - apps[app_id].submitted_at).total_seconds()
        for app_id, d in first_final.items()
        if apps[app_id].submitted_at
    ]
    to_issue = [(a.closed_at - a.submitted_at).total_seconds() for a in issued if a.closed_at and a.submitted_at]
    info_response = [
        (r.answered_at - r.created_at).total_seconds()
        for r in data.info_requests
        if r.status == InfoStatus.ANSWERED and r.answered_at
    ]
    review_started: dict[uuid.UUID, list[datetime]] = defaultdict(list)
    for h in data.manual_review_history:
        review_started[h.application_id].append(h.created_at)
    review_seconds: dict[uuid.UUID | None, list[float]] = defaultdict(list)
    breached = 0
    for d in data.decisions:
        if d.kind != DecisionKind.MANUAL or d.outcome not in FINAL_OUTCOMES:
            continue
        starts = [t for t in review_started.get(d.application_id, []) if t <= d.created_at]
        if starts:
            review_seconds[d.decided_by].append((d.created_at - starts[-1]).total_seconds())
        due = apps[d.application_id].sla_due_at
        if due and d.created_at > due:
            breached += 1
    all_review = [s for values in review_seconds.values() for s in values]

    # Предложения: по заявкам, а не по вариантам — у контрпредложения их может быть два
    offered = {o.application_id for o in data.offers}
    accepted = {o.application_id for o in data.offers if o.status == OfferStatus.ACCEPTED}
    counter_apps = {
        app_id
        for app_id in offered
        if all(o.kind == OfferKind.COUNTER for o in data.offers if o.application_id == app_id)
    }

    reasons: Counter[str] = Counter()
    stop_factors: Counter[str] = Counter()
    for d in last_final.values():
        if d.outcome == Outcome.REJECT:
            reasons.update(d.reason_codes or [])
            stop_factors.update(d.stop_factors or [])
    rejection_reasons = [
        MetricCount(code=code, title=STOP_FACTOR_TITLES.get(code, code), count=count)
        for code, count in stop_factors.most_common()
    ] + [
        MetricCount(code=code, title=REASONS[code][0] if code in REASONS else code, count=count)
        for code, count in reasons.most_common()
    ]

    by_product: dict[str, ProductMetrics] = {}
    for code, product in data.products.items():
        by_product[code] = ProductMetrics(code=code, name=product.name)
    for a in data.applications:
        row = by_product.setdefault(a.product_code, ProductMetrics(code=a.product_code, name=a.product_code))
        row.applications += 1
        final = last_final.get(a.id)
        if final and final.outcome in APPROVED_OUTCOMES:
            row.approved += 1
        if a.status == AppStatus.ISSUED and a.id in loan_by_app:
            row.issued += 1
            row.issued_amount += loan_by_app[a.id].amount
    products = [row for row in by_product.values() if row.applications]

    manual_now = [a for a in data.applications if a.status == AppStatus.MANUAL_REVIEW]
    analysts = []
    for user in data.analysts:
        decided_by_user = sum(
            1 for d in last_final.values() if d.kind == DecisionKind.MANUAL and d.decided_by == user.id
        )
        in_work = [a for a in manual_now if a.assignee_id == user.id]
        analysts.append(
            AnalystMetrics(
                name=user.full_name,
                decided=decided_by_user,
                in_work=len(in_work),
                overdue=sum(1 for a in in_work if a.sla_due_at and a.sla_due_at < data.now),
                median_review_hours=hours(review_seconds.get(user.id, [])),
            )
        )

    # Динамика по дням — по московской дате: с 00:00 до 03:00 МСК в UTC ещё вчера, и сегодняшние заявки
    # попали бы во вчерашний столбец
    daily: dict[date, DailyMetrics] = {}
    start = moscow_date(data.now) - timedelta(days=data.days - 1)
    for offset in range(data.days):
        day = start + timedelta(days=offset)
        daily[day] = DailyMetrics(date=day)
    for a in data.applications:
        if a.submitted_at and moscow_date(a.submitted_at) in daily:
            daily[moscow_date(a.submitted_at)].submitted += 1
        if a.status == AppStatus.ISSUED and a.closed_at and moscow_date(a.closed_at) in daily:
            daily[moscow_date(a.closed_at)].issued += 1
    for d in first_final.values():
        if moscow_date(d.created_at) in daily:
            daily[moscow_date(d.created_at)].decided += 1

    return BankMetrics(
        period_days=data.days,
        since=data.now - timedelta(days=data.days),
        until=data.now,
        submitted=len(data.applications),
        in_progress=sum(1 for a in data.applications if a.status in active),
        decided=decided,
        auto_decided=auto,
        manual_decided=decided - auto,
        automation_share=share(auto, decided),
        manual_review=len(went_to_review),
        need_info=len(asked_info),
        issued=len(issued),
        issued_amount=issued_amount,
        outcomes=[
            MetricCount(code=outcome, title=OUTCOME_TITLES[outcome], count=count)
            for outcome, count in Counter(d.outcome for d in last_final.values()).most_common()
        ],
        to_decision_median_seconds=median(to_decision),
        to_decision_p95_seconds=percentile(to_decision, 0.95),
        to_issue_median_hours=hours(to_issue),
        info_response_median_hours=hours(info_response),
        review_median_hours=hours(all_review),
        offered=len(offered),
        accepted=len(accepted),
        offer_conversion=share(len(accepted), len(offered)),
        counter_offered=len(counter_apps),
        counter_accepted=len(counter_apps & accepted),
        counter_conversion=share(len(counter_apps & accepted), len(counter_apps)),
        sla_overdue_now=sum(1 for a in manual_now if a.sla_due_at and a.sla_due_at < data.now),
        sla_breached=breached,
        rejection_reasons=rejection_reasons,
        products=products,
        analysts=analysts,
        daily=list(daily.values()),
    )


def bank_metrics(db: Session, *, days: int, now: datetime) -> BankMetrics:
    return compute(load_input(db, days=days, now=now))
