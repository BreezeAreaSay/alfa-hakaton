"""Предварительный лимит по выписке без заявки: признаки строятся по выписке, допуск — по счёту в банке."""

from datetime import date
from decimal import Decimal

from app.domain.catalog import PRODUCTS
from app.domain.proactive import proactive_offers, statement_facts, statement_features

CATALOG = {p.code: p for p in PRODUCTS}
TODAY = date(2026, 10, 24)
EGRUL = {
    "found": True,
    "legal_form": "IP",
    "status": "ACTIVE",
    "okved": "56.30",
    "registration_date": "2024-08-24",
    "director": {"since": "2024-08-24"},
}


def statement(avg: float, months: int = 12) -> dict:
    return {
        "months": [{"month": f"2026-{m:02d}", "inflow": avg, "outflow": avg * 0.9} for m in range(1, months + 1)],
        "avg_monthly_inflow": avg,
    }


def test_statement_replaces_bank_turnover_for_client():
    bank = {"is_client": True, "account_opened_at": "2024-09-24", "months": [{"month": "2026-09", "inflow": 100.0}]}
    f = statement_features(today=TODAY, egrul=EGRUL, bank=bank, statement=statement(750_000))
    assert f.is_bank_client and f.account_months >= 3
    assert f.avg_monthly_inflow == Decimal("750000.00")
    assert f.revenue == Decimal("9000000.00")
    offers = proactive_offers(CATALOG, f)
    codes = {o["product_code"] for o in offers}
    assert "OVERDRAFT" in codes
    overdraft = next(o for o in offers if o["product_code"] == "OVERDRAFT")
    assert overdraft["amount"] <= 750_000 * 0.4


def test_without_bank_account_only_loans_without_account_requirement():
    f = statement_features(today=TODAY, egrul=EGRUL, bank=None, statement=statement(750_000))
    assert not f.is_bank_client
    assert f.revenue_source == "STATEMENT"
    offers = proactive_offers(CATALOG, f)
    assert all(CATALOG[o["product_code"]].requires_bank_account_months is None for o in offers)


def test_facts_mention_statement_and_business_age():
    f = statement_features(today=TODAY, egrul=EGRUL, bank=None, statement=statement(750_000))
    facts = statement_facts(f, statement(750_000))
    assert facts[0].startswith("По выписке: 12 мес.")
    assert any("Бизнес работает" in fact for fact in facts)
