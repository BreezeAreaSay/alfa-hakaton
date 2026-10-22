"""Прогноз кассового разрыва по помесячным поступлениям и списаниям."""

from app.domain.cashflow import forecast, next_month, slope


def months(pairs: list[tuple[float, float]], start: str = "2025-10") -> list[dict]:
    return [
        {"month": next_month(start, i), "inflow": inflow, "outflow": outflow}
        for i, (inflow, outflow) in enumerate(pairs)
    ]


def test_steady_surplus_has_no_gap():
    f = forecast(months([(900_000, 700_000)] * 12), closing_balance=150_000)
    assert f["gap"] == 0 and f["recommendation"] == {"product": None, "amount": 0, "reason": "NO_GAP"}
    assert f["deficit_months"] == [] and f["min_balance"] == 150_000 and f["min_balance_month"] is None
    assert [m["month"] for m in f["months"]] == ["2026-10", "2026-11", "2026-12"]
    assert f["months"][-1]["balance"] == 150_000 + 3 * 200_000
    assert f["trend_inflow"] == 0 and f["trend_outflow"] == 0


def test_falling_inflow_predicts_gap_and_overdraft_limit():
    inflow = [900_000] * 9 + [800_000, 700_000, 600_000]
    f = forecast(months([(i, 750_000) for i in inflow]), closing_balance=None)
    assert f["balance_known"] is False
    assert f["deficit_months"] == ["2026-08", "2026-09"]
    assert f["trend_inflow"] < 0 and f["gap"] > 0
    assert f["min_balance_month"] == "2026-12" and f["min_balance"] == -f["gap"]
    rec = f["recommendation"]
    assert rec["product"] == "OVERDRAFT" and rec["reason"] == "GAP_COVERED_BY_OVERDRAFT"
    assert rec["amount"] % 10_000 == 0 and rec["amount"] >= f["gap"] * 1.2
    assert rec["amount"] <= f["overdraft_cap"] == 340_000  # 40 % от средних поступлений, вниз до 10 тыс.


def test_large_gap_needs_credit_line():
    f = forecast(months([(500_000, 900_000)] * 6), closing_balance=100_000)
    assert f["gap"] == 3 * 400_000 - 100_000
    assert f["recommendation"]["product"] == "CREDIT_LINE"
    assert f["recommendation"]["reason"] == "GAP_ABOVE_OVERDRAFT_LIMIT"


def test_short_history_has_no_trend():
    f = forecast(months([(300_000, 200_000), (320_000, 210_000)]), closing_balance=None)
    assert f["trend_inflow"] == 0 and f["months"][0]["inflow"] == 310_000


def test_slope_and_next_month():
    assert slope([1, 2, 3, 4]) == 1
    assert slope([5, 5]) == 0
    assert next_month("2026-11", 2) == "2027-01"
