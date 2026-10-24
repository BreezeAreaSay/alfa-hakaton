"""Предварительные предложения на главной: по данным компании без заявки и кредитной истории."""

from decimal import Decimal

from app.domain.catalog import PRODUCTS
from app.domain.proactive import NOTE_NO_DATA, NOTE_PRELIMINARY, proactive_facts, proactive_note, proactive_offers
from tests.unit.factories import strong_company

CATALOG = {p.code: p for p in PRODUCTS}


def test_strong_client_gets_overdraft_and_growth_loan():
    f = strong_company()
    offers = proactive_offers(CATALOG, f)
    assert [o["product_code"] for o in offers] == ["OVERDRAFT", "GROWTH"]
    overdraft, growth = offers
    # овердрафт: 40 % среднемесячных поступлений, но не больше автолимита 5 млн
    assert overdraft["amount"] == 4_000_000 and overdraft["term_months"] == 12 and overdraft["purpose"] == "CASH_GAP"
    # кредит на развитие: платёжеспособность даёт больше автолимита — предлагаем автолимит 10 млн на 36 месяцев
    assert growth["amount"] == 10_000_000 and growth["term_months"] == 36
    assert growth["rate_from"] == 19.0 and growth["monthly_payment"] > 0
    assert proactive_note(f, offers) == NOTE_PRELIMINARY


def test_facts_explain_the_offer():
    facts = proactive_facts(strong_company())
    assert facts[0] == "Бизнес работает 6 лет 2 мес."
    assert "Выручка по отчётности — 120\u00a0000\u00a0000\u00a0₽ в год" in facts
    assert "Выручка выросла на 14\u00a0% за год" in facts
    assert "Поступления на счёт — в среднем 10\u00a0000\u00a0000\u00a0₽ в месяц" in facts


def test_young_business_and_recent_account_get_only_what_is_allowed():
    f = strong_company(business_months=10, account_months=2, inflow_months=2, revenue_source="BANK", sales_profit=None)
    codes = [o["product_code"] for o in proactive_offers(CATALOG, f)]
    assert codes == ["EXPRESS"]  # кредит на развитие и линия — от года, овердрафт — от 6 месяцев на счёте


def test_no_revenue_source_means_no_offers_but_a_hint():
    f = strong_company(revenue=None, revenue_source=None, operating_profit_month=None, avg_monthly_inflow=None)
    assert proactive_offers(CATALOG, f) == []
    assert proactive_note(f, []) == NOTE_NO_DATA


def test_inactive_company_gets_nothing():
    f = strong_company(company_status="LIQUIDATING")
    assert proactive_offers(CATALOG, f) == [] and proactive_note(f, []) is None


def test_amount_never_exceeds_payment_capacity():
    # Платежи по кредитам съедают почти всю прибыль: лимит по DSCR маленький, ниже минимума продукта — предложения нет
    f = strong_company(existing_payments=Decimal("615000"), avg_monthly_inflow=None, is_bank_client=False)
    assert proactive_offers(CATALOG, f) == []
