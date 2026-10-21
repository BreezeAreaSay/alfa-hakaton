from decimal import Decimal

from app.domain.features import Features


def strong_company(**overrides) -> Features:
    """Устойчивая компания: опт, 6 лет, растущая выручка, чистая кредитная история, клиент банка."""
    values = dict(
        legal_form="OOO",
        company_status="ACTIVE",
        business_months=74,
        okved="46.90",
        industry_risk="MEDIUM",
        industry_margin=Decimal("0.08"),
        revenue=Decimal("120000000"),
        revenue_source="GIRBO",
        revenue_prev=Decimal("105000000"),
        sales_profit=Decimal("9600000"),
        operating_profit_month=Decimal("800000"),
        revenue_growth=0.143,
        margin=0.08,
        has_credit_history=True,
        existing_payments=Decimal("150000"),
        dscr_current=5.33,
        is_bank_client=True,
        account_months=60,
        inflow_months=12,
        inflow_cv=0.12,
        avg_monthly_inflow=Decimal("10000000"),
        amount=Decimal("3000000"),
        term_months=24,
        amount_share=0.025,
    )
    values.update(overrides)
    return Features(**values)
