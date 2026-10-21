from decimal import Decimal

from app.domain.scoring import risk_class_for, score
from tests.unit.factories import strong_company


def test_strong_company_gets_class_a():
    result = score(strong_company())
    assert result.risk_class == "A"
    assert result.score == 600 + 50 + 60 + 60 + 30 + 10 + 40 + 0 + 0 + 20
    assert result.rate_margin == Decimal("0")


def test_every_factor_is_explained():
    result = score(strong_company())
    codes = [f.code for f in result.factors]
    assert codes == [
        "BUSINESS_AGE",
        "CREDIT_HISTORY",
        "DEBT_LOAD",
        "REVENUE_TREND",
        "MARGIN",
        "ACCOUNT",
        "TAX_DEBT",
        "INDUSTRY",
        "AMOUNT_SHARE",
    ]
    assert all(f.phrase for f in result.factors if f.points != 0)


def test_weak_company_gets_class_e():
    features = strong_company(
        business_months=20,
        max_overdue_days_24m=45,
        dscr_current=0.8,
        revenue_growth=-0.35,
        margin=-0.02,
        is_bank_client=False,
        tax_debt=Decimal("250000"),
        industry_risk="HIGH",
        amount_share=0.7,
    )
    result = score(features)
    assert result.risk_class == "E"
    assert result.rate_margin is None


def test_class_boundaries():
    assert risk_class_for(760)[0] == "A"
    assert risk_class_for(759)[0] == "B"
    assert risk_class_for(680)[0] == "B"
    assert risk_class_for(679)[0] == "C"
    assert risk_class_for(600)[0] == "C"
    assert risk_class_for(599)[0] == "D"
    assert risk_class_for(520)[0] == "D"
    assert risk_class_for(519)[0] == "E"


def test_irregular_inflows_are_penalised():
    result = score(strong_company(inflow_cv=0.9))
    account = next(f for f in result.factors if f.code == "ACCOUNT")
    assert account.points == -20
