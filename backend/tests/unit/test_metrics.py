"""Показатели конвейера: расчёт на данных трёх заявок с разными исходами."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace as Row

from app.services.metrics import MetricsInput, compute, percentile

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)
ANALYST = uuid.uuid4()
A, B, C = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


def at(**delta: float) -> datetime:
    return NOW - timedelta(**delta)


def sample() -> MetricsInput:
    applications = [
        # автоодобрение и выдача за 2 минуты
        Row(
            id=A,
            product_code="GROWTH",
            status="ISSUED",
            submitted_at=at(days=1, minutes=10),
            closed_at=at(days=1),
            sla_due_at=None,
            assignee_id=None,
        ),
        # ручное рассмотрение: контрпредложение принято, срок рассмотрения нарушен
        Row(
            id=B,
            product_code="GROWTH",
            status="ACCEPTED",
            submitted_at=at(days=3),
            closed_at=None,
            sla_due_at=at(days=2),
            assignee_id=ANALYST,
        ),
        # отказ по стоп-фактору
        Row(
            id=C,
            product_code="EXPRESS",
            status="REJECTED",
            submitted_at=at(hours=5),
            closed_at=at(hours=4, minutes=58),
            sla_due_at=None,
            assignee_id=None,
        ),
    ]
    decisions = [
        Row(
            application_id=A,
            kind="AUTO",
            outcome="APPROVE",
            created_at=at(days=1, minutes=8),
            decided_by=None,
            reason_codes=[],
            stop_factors=[],
        ),
        Row(
            application_id=B,
            kind="AUTO",
            outcome="MANUAL_REVIEW",
            created_at=at(days=3) + timedelta(minutes=1),
            decided_by=None,
            reason_codes=[],
            stop_factors=[],
        ),
        Row(
            application_id=B,
            kind="MANUAL",
            outcome="COUNTER",
            created_at=at(days=1, hours=12),
            decided_by=ANALYST,
            reason_codes=[],
            stop_factors=[],
        ),
        Row(
            application_id=C,
            kind="AUTO",
            outcome="REJECT",
            created_at=at(hours=4, minutes=59),
            decided_by=None,
            reason_codes=[],
            stop_factors=["S01"],
        ),
    ]
    offers = [
        Row(application_id=A, kind="AS_REQUESTED", status="ACCEPTED"),
        Row(application_id=B, kind="COUNTER", status="ACCEPTED"),
        Row(application_id=B, kind="COUNTER", status="VOID"),
    ]
    history = [Row(application_id=B, created_at=at(days=3) + timedelta(minutes=1))]
    loans = [Row(application_id=A, amount=Decimal("3000000"))]
    analysts = [Row(id=ANALYST, full_name="Иванова Ольга")]
    products = {"GROWTH": Row(name="Кредит на развитие"), "EXPRESS": Row(name="Экспресс-кредит")}
    return MetricsInput(NOW, 30, applications, decisions, offers, [], history, loans, analysts, products)


def test_funnel_and_automation():
    m = compute(sample())
    assert (m.submitted, m.decided, m.auto_decided, m.manual_decided) == (3, 3, 2, 1)
    assert m.automation_share == 0.667
    assert m.manual_review == 1
    assert m.in_progress == 1  # заявка B принята, но ещё не выдана
    assert (m.issued, m.issued_amount) == (1, Decimal("3000000"))
    assert [(o.code, o.count) for o in m.outcomes] == [("APPROVE", 1), ("COUNTER", 1), ("REJECT", 1)]


def test_timings_offers_and_reasons():
    m = compute(sample())
    assert m.to_decision_median_seconds == 120  # A: 2 минуты, C: 1 минута, B: 1,5 суток → медиана A
    assert m.to_issue_median_hours == 0.2
    assert m.review_median_hours == 36.0
    assert (m.offered, m.accepted, m.offer_conversion) == (2, 2, 1.0)
    assert (m.counter_offered, m.counter_accepted, m.counter_conversion) == (1, 1, 1.0)
    assert [(r.code, r.count) for r in m.rejection_reasons] == [("S01", 1)]
    assert m.sla_breached == 1 and m.sla_overdue_now == 0


def test_products_analysts_and_daily():
    m = compute(sample())
    growth = next(p for p in m.products if p.code == "GROWTH")
    assert (growth.applications, growth.approved, growth.issued) == (2, 2, 1)
    assert m.analysts[0].name == "Иванова Ольга"
    assert (m.analysts[0].decided, m.analysts[0].in_work, m.analysts[0].median_review_hours) == (1, 0, 36.0)
    assert len(m.daily) == 30 and m.daily[-1].date == NOW.date()
    assert sum(d.submitted for d in m.daily) == 3 and sum(d.issued for d in m.daily) == 1


def test_empty_period():
    m = compute(MetricsInput(NOW, 7, [], [], [], [], [], [], [], {}))
    assert m.submitted == 0 and m.automation_share is None and m.to_decision_median_seconds is None
    assert m.products == [] and len(m.daily) == 7


def test_percentile():
    assert percentile([], 0.95) is None
    assert percentile([5, 1, 3], 0.5) == 3
    assert percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95) == 10
