from datetime import date
from decimal import Decimal

from app.domain.finance import (
    add_months,
    annuity_payment,
    max_principal,
    overpayment,
    payment_schedule,
    round_down,
)


def test_annuity_payment_matches_reference():
    assert annuity_payment(Decimal("1000000"), Decimal("12"), 12) == Decimal("88848.79")


def test_max_principal_inverts_annuity():
    payment = annuity_payment(Decimal("3000000"), Decimal("19"), 24)
    assert abs(max_principal(payment, Decimal("19"), 24) - Decimal("3000000")) < Decimal("1")


def test_overpayment_is_total_minus_principal():
    assert overpayment(Decimal("1000000"), Decimal("12"), 12) == Decimal("66185.48")


def test_round_down_to_ten_thousand():
    assert round_down(Decimal("1574321.17")) == Decimal("1570000")
    assert round_down(Decimal("-5")) == Decimal("0")


def test_schedule_repays_principal_exactly():
    rows = payment_schedule(Decimal("1000000"), Decimal("19"), 24, date(2026, 1, 31))
    assert len(rows) == 24
    assert rows[-1].balance == Decimal("0.00")
    assert sum(r.principal for r in rows) == Decimal("1000000.00")
    assert rows[0].due_date == date(2026, 2, 28)


def test_add_months_handles_leap_years():
    assert add_months(date(2027, 12, 31), 2) == date(2028, 2, 29)
