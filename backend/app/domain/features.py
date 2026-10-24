"""Признаки для скоринга и политики из нормализованных ответов источников (docs/credit-policy.md)."""

import statistics
from dataclasses import asdict, dataclass, field, fields
from datetime import date
from decimal import Decimal
from typing import Any

from app.domain.finance import money

LOW_RISK_OKVED = {"62", "63", "69", "70", "86"}
HIGH_RISK_OKVED = {"41", "42", "43", "55", "56", "68"}


def industry_risk(okved: str | None) -> str:
    prefix = (okved or "")[:2]
    if prefix in LOW_RISK_OKVED:
        return "LOW"
    if prefix in HIGH_RISK_OKVED:
        return "HIGH"
    return "MEDIUM"


def industry_margin(okved: str | None) -> Decimal:
    """Отраслевая маржа для оценки прибыли, когда нет отчётности."""
    try:
        code = int((okved or "0")[:2])
    except ValueError:
        code = 0
    if code in (45, 46, 47):
        return Decimal("0.08")
    if 10 <= code <= 33:
        return Decimal("0.12")
    if 49 <= code <= 53:
        return Decimal("0.12")
    if code in (41, 42, 43):
        return Decimal("0.10")
    if code in (55, 56):
        return Decimal("0.15")
    return Decimal("0.20")


def months_between(start: date, end: date) -> int:
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day < start.day:
        months -= 1
    return max(months, 0)


def _date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _dec(value: Any) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


@dataclass
class Features:
    legal_form: str | None = None
    company_status: str | None = None
    business_months: int | None = None
    okved: str | None = None
    industry_risk: str = "MEDIUM"
    industry_margin: Decimal = Decimal("0.20")

    revenue: Decimal | None = None
    revenue_source: str | None = None
    revenue_prev: Decimal | None = None
    sales_profit: Decimal | None = None
    operating_profit_month: Decimal | None = None
    revenue_growth: float | None = None
    margin: float | None = None

    has_credit_history: bool = False
    existing_payments: Decimal = Decimal(0)
    existing_debt: Decimal = Decimal(0)
    dscr_current: float | None = None
    max_overdue_days_24m: int = 0
    current_overdue_days: int = 0

    is_bank_client: bool = False
    account_months: int = 0
    inflow_months: int = 0
    inflow_cv: float | None = None
    avg_monthly_inflow: Decimal | None = None

    tax_debt: Decimal = Decimal(0)
    mass_address: bool = False
    director_disqualified: bool = False
    director_months: int | None = None

    amount: Decimal = Decimal(0)
    term_months: int = 0
    declared_revenue: Decimal | None = None
    revenue_discrepancy: float | None = None
    amount_share: float | None = None

    unavailable_sources: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        for key, value in result.items():
            if isinstance(value, Decimal):
                result[key] = float(value)
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Features":
        """Обратно из сохранённого скоринга: суммы снова становятся Decimal."""
        kwargs: dict[str, Any] = {}
        for item in fields(cls):
            if item.name not in data:
                continue
            value = data[item.name]
            if value is not None and "Decimal" in str(item.type):
                value = Decimal(str(value))
            kwargs[item.name] = value
        return cls(**kwargs)


def _inflow_stats(months: list[dict[str, Any]]) -> tuple[int, float | None, Decimal | None, Decimal | None]:
    """Число месяцев с поступлениями, коэффициент вариации, среднемесячные поступления и выручка за год."""
    values = [float(m.get("inflow") or 0) for m in months[-12:]]
    if not values:
        return 0, None, None, None
    with_inflow = [v for v in values if v > 0]
    mean = sum(values) / len(values)
    cv = statistics.pstdev(values) / mean if mean > 0 and len(values) > 1 else None
    avg = money(mean)
    annual = money(mean * 12)
    return len(with_inflow), cv, avg, annual


def build_features(
    *,
    today: date,
    amount: Decimal,
    term_months: int,
    declared_revenue: Decimal | None,
    egrul: dict[str, Any] | None,
    fns: dict[str, Any] | None,
    girbo: dict[str, Any] | None,
    bki: dict[str, Any] | None,
    bank: dict[str, Any] | None,
    statement: dict[str, Any] | None,
    unavailable_sources: list[str] | None = None,
) -> Features:
    f = Features(amount=Decimal(amount), term_months=term_months, declared_revenue=declared_revenue)
    f.unavailable_sources = list(unavailable_sources or [])

    if egrul and egrul.get("found"):
        f.legal_form = egrul.get("legal_form")
        f.company_status = egrul.get("status")
        f.okved = egrul.get("okved")
        registered = _date(egrul.get("registration_date"))
        if registered:
            f.business_months = months_between(registered, today)
        director_since = _date((egrul.get("director") or {}).get("since"))
        if director_since:
            f.director_months = months_between(director_since, today)
    f.industry_risk = industry_risk(f.okved)
    f.industry_margin = industry_margin(f.okved)

    if fns:
        f.tax_debt = _dec(fns.get("tax_debt")) or Decimal(0)
        f.mass_address = bool(fns.get("mass_address"))
        f.director_disqualified = bool(fns.get("director_disqualified"))

    if bki:
        f.has_credit_history = bool(bki.get("has_history"))
        loans = bki.get("loans") or []
        f.existing_payments = money(sum(Decimal(str(loan.get("monthly_payment") or 0)) for loan in loans))
        f.existing_debt = money(sum(Decimal(str(loan.get("balance") or 0)) for loan in loans))
        f.max_overdue_days_24m = int(bki.get("max_overdue_days_24m") or 0)
        f.current_overdue_days = int(bki.get("current_overdue_days") or 0)

    bank_annual = None
    if bank and bank.get("is_client"):
        f.is_bank_client = True
        opened = _date(bank.get("account_opened_at"))
        if opened:
            f.account_months = months_between(opened, today)
        f.inflow_months, f.inflow_cv, f.avg_monthly_inflow, bank_annual = _inflow_stats(bank.get("months") or [])

    statement_annual = None
    statement_avg = None
    if statement and statement.get("months"):
        _, _, statement_avg, statement_annual = _inflow_stats(statement["months"])

    # Источник выручки по приоритету: отчётность → поступления на счёт в банке → выписка клиента.
    years = sorted((girbo or {}).get("years") or [], key=lambda y: y["year"], reverse=True)
    if girbo and girbo.get("available") and years:
        last = years[0]
        f.revenue = _dec(last.get("revenue"))
        f.sales_profit = _dec(last.get("sales_profit"))
        f.revenue_source = "GIRBO"
        if len(years) > 1:
            f.revenue_prev = _dec(years[1].get("revenue"))
    elif bank_annual is not None and f.account_months >= 3:
        f.revenue = bank_annual
        f.revenue_source = "BANK"
    elif statement_annual is not None:
        f.revenue = statement_annual
        f.revenue_source = "STATEMENT"
        if f.avg_monthly_inflow is None:
            f.avg_monthly_inflow = statement_avg

    if f.revenue is not None and f.revenue > 0:
        if f.sales_profit is not None:
            f.operating_profit_month = money(f.sales_profit / 12)
            f.margin = float(f.sales_profit / f.revenue)
        else:
            f.operating_profit_month = money(f.revenue * f.industry_margin / 12)
        if f.revenue_prev:
            f.revenue_growth = float(f.revenue / f.revenue_prev - 1)
        f.amount_share = float(Decimal(amount) / f.revenue)
        if declared_revenue:
            f.revenue_discrepancy = float(abs(Decimal(declared_revenue) - f.revenue) / f.revenue)

    if f.operating_profit_month is not None and f.existing_payments > 0:
        f.dscr_current = float(f.operating_profit_month / f.existing_payments)

    return f
