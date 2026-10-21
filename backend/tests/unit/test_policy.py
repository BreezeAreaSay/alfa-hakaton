from decimal import Decimal

from app.domain.catalog import PRODUCTS
from app.domain.enums import Outcome
from app.domain.policy import check_analyst_terms, compute_limit, decide, eligibility_issues
from app.domain.scoring import score
from tests.unit.factories import strong_company

P = {p.code: p for p in PRODUCTS}


def run(product_code: str, amount: str, term: int, collateral: str | None = None, **overrides):
    features = strong_company(amount=Decimal(amount), term_months=term, **overrides)
    s = score(features)
    return decide(
        P[product_code],
        features,
        s,
        amount=Decimal(amount),
        term_months=term,
        collateral_value=Decimal(collateral) if collateral else None,
    ), s


def test_strong_company_is_approved_automatically():
    d, _ = run("GROWTH", "3000000", 24)
    assert d.outcome == Outcome.APPROVE
    assert d.rate == Decimal("19.0")
    [option] = d.options
    assert option.kind == "AS_REQUESTED"
    assert option.amount == Decimal("3000000.00")
    assert option.monthly_payment > 0


def test_liquidating_company_is_rejected_by_stop_factor():
    d, _ = run("GROWTH", "3000000", 24, company_status="LIQUIDATING")
    assert d.outcome == Outcome.REJECT
    assert d.stop_factors == ["S01"]


def test_current_overdue_over_30_days_is_stop_factor():
    d, _ = run("GROWTH", "3000000", 24, current_overdue_days=45, max_overdue_days_24m=45)
    assert d.outcome == Outcome.REJECT
    assert "S03" in d.stop_factors


def test_missing_financial_source_requests_statement():
    d, _ = run(
        "EXPRESS",
        "2000000",
        24,
        revenue=None,
        revenue_source=None,
        sales_profit=None,
        operating_profit_month=None,
        revenue_prev=None,
        revenue_growth=None,
        margin=None,
        amount_share=None,
        is_bank_client=False,
        inflow_months=0,
        avg_monthly_inflow=None,
    )
    assert d.outcome == Outcome.NEED_INFO
    assert d.info_items[0]["code"] == "BANK_STATEMENT"


def test_flags_send_application_to_analyst():
    d, _ = run("GROWTH", "3000000", 24, mass_address=True, tax_debt=Decimal("80000"))
    assert d.outcome == Outcome.MANUAL_REVIEW
    assert d.flags == ["F01", "F02"]
    assert d.limit is not None


def test_secured_product_always_goes_to_analyst():
    d, _ = run("SECURED", "60000000", 84, collateral="120000000")
    assert d.outcome == Outcome.MANUAL_REVIEW
    assert d.flags == []


def test_overdraft_is_limited_by_inflows():
    d, _ = run("OVERDRAFT", "1000000", 12, avg_monthly_inflow=Decimal("1100000"))
    assert d.outcome == Outcome.COUNTER
    assert d.limit == Decimal("440000")
    assert d.limit_binding == "OVERDRAFT"
    assert [o.amount for o in d.options] == [Decimal("440000.00")]


def test_counter_offer_suggests_longer_term_when_it_fits():
    # Прибыль позволяет 4 млн на 60 мес., но не на 12.
    d, _ = run(
        "GROWTH",
        "4000000",
        12,
        operating_profit_month=Decimal("300000"),
        existing_payments=Decimal("100000"),
        dscr_current=3.0,
        revenue=Decimal("40000000"),
        amount_share=0.1,
    )
    assert d.outcome == Outcome.COUNTER
    kinds = [(o.amount, o.term_months) for o in d.options]
    assert kinds[0][0] == Decimal("4000000.00") and kinds[0][1] > 12
    assert kinds[-1][1] == 12 and kinds[-1][0] < Decimal("4000000")


def test_limit_below_product_minimum_is_rejected():
    d, _ = run(
        "GROWTH",
        "3000000",
        24,
        operating_profit_month=Decimal("60000"),
        existing_payments=Decimal("45000"),
        dscr_current=1.33,
    )
    assert d.outcome == Outcome.REJECT
    assert d.reason_codes == ["R02"]


def test_amount_above_auto_limit_goes_to_analyst():
    d, _ = run("GROWTH", "12000000", 36)
    assert d.outcome == Outcome.MANUAL_REVIEW


def test_young_business_is_not_eligible_for_growth():
    issues = eligibility_issues(P["GROWTH"], business_months=5, is_bank_client=True, account_months=5)
    assert [i.code for i in issues] == ["BUSINESS_AGE"]
    assert not eligibility_issues(P["STARTUP"], business_months=5, is_bank_client=True, account_months=5)


def test_overdraft_requires_bank_account():
    issues = eligibility_issues(P["OVERDRAFT"], business_months=40, is_bank_client=False, account_months=0)
    assert [i.code for i in issues] == ["BANK_ACCOUNT"]


def test_dscr_limit_respects_minimum_coverage():
    features = strong_company(operating_profit_month=Decimal("400000"), existing_payments=Decimal("250000"))
    result = compute_limit(P["GROWTH"], features, rate=Decimal("20.5"), term_months=36, collateral_value=None)
    assert result.binding == "DSCR"
    assert Decimal("1500000") < result.limit < Decimal("1700000")


def test_analyst_cannot_exceed_limit_by_more_than_20_percent():
    product = P["GROWTH"]
    common = dict(term_months=24, rate=Decimal("20.5"), limit=Decimal("5000000"), min_rate=Decimal("20.5"))
    assert check_analyst_terms(product, amount=Decimal("5000000"), comment=None, **common) == []
    assert check_analyst_terms(product, amount=Decimal("5500000"), comment=None, **common)
    assert check_analyst_terms(product, amount=Decimal("5500000"), comment="Есть госконтракт", **common) == []
    assert check_analyst_terms(product, amount=Decimal("7000000"), comment="—", **common)
