"""Балльная скоринговая карта (docs/credit-policy.md, «Скоринговая карта»)."""

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from app.domain.features import Features
from app.domain.text import months_text, percent, rub

SCORING_VERSION = "v1.0"
BASE_SCORE = 600

RISK_CLASSES: tuple[tuple[str, int, Decimal | None, Decimal], ...] = (
    # класс, минимальный балл, надбавка к ставке (п.п.), условная вероятность дефолта (%)
    ("A", 760, Decimal("0"), Decimal("1")),
    ("B", 680, Decimal("1.5"), Decimal("3")),
    ("C", 600, Decimal("3"), Decimal("6")),
    ("D", 520, Decimal("5"), Decimal("12")),
    ("E", -10_000, None, Decimal("25")),
)


@dataclass
class Factor:
    code: str
    title: str
    value: str
    points: int
    phrase: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "title": self.title,
            "value": self.value,
            "points": self.points,
            "phrase": self.phrase,
        }


@dataclass
class ScoreResult:
    score: int
    risk_class: str
    pd: Decimal
    rate_margin: Decimal | None
    factors: list[Factor]


def _business_age(f: Features) -> Factor:
    title = "Срок ведения бизнеса"
    m = f.business_months
    if m is None:
        return Factor("BUSINESS_AGE", title, "нет данных", 0)
    value = months_text(m)
    if m < 12:
        return Factor("BUSINESS_AGE", title, value, -60, "Бизнесу меньше года")
    if m < 36:
        return Factor("BUSINESS_AGE", title, value, 0)
    if m < 60:
        return Factor("BUSINESS_AGE", title, value, 30, "Бизнес работает больше 3 лет")
    return Factor("BUSINESS_AGE", title, value, 50, "Бизнес работает больше 5 лет")


def _credit_history(f: Features) -> Factor:
    title = "Кредитная история"
    if not f.has_credit_history:
        return Factor("CREDIT_HISTORY", title, "нет кредитной истории", 0)
    days = f.max_overdue_days_24m
    if days == 0:
        return Factor("CREDIT_HISTORY", title, "без просрочек за 24 мес.", 60, "Кредиты погашаются без просрочек")
    if days < 30:
        return Factor("CREDIT_HISTORY", title, f"просрочки до {days} дн.", -40, "Были небольшие просрочки по кредитам")
    return Factor(
        "CREDIT_HISTORY", title, f"просрочки до {days} дн.", -120, "Были просрочки по кредитам больше 30 дней"
    )


def _debt_load(f: Features) -> Factor:
    title = "Текущая долговая нагрузка (DSCR)"
    if f.existing_payments == 0:
        return Factor("DEBT_LOAD", title, "нет действующих кредитов", 60, "Нет действующих кредитов")
    if f.dscr_current is None:
        return Factor("DEBT_LOAD", title, "нет данных о прибыли", 0)
    dscr = f.dscr_current
    value = f"{dscr:.2f}".replace(".", ",") + f" (платежи {rub(f.existing_payments)} в мес.)"
    if dscr >= 2.0:
        return Factor("DEBT_LOAD", title, value, 60, "Невысокая текущая долговая нагрузка")
    if dscr >= 1.5:
        return Factor("DEBT_LOAD", title, value, 30, "Умеренная долговая нагрузка")
    if dscr >= 1.3:
        return Factor("DEBT_LOAD", title, value, 0)
    if dscr >= 1.0:
        return Factor("DEBT_LOAD", title, value, -60, "Высокая текущая долговая нагрузка")
    return Factor("DEBT_LOAD", title, value, -150, "Платежи по кредитам превышают прибыль")


def _revenue_trend(f: Features) -> Factor:
    title = "Динамика выручки за год"
    g = f.revenue_growth
    if g is None:
        return Factor("REVENUE_TREND", title, "нет данных за два года", 0)
    value = ("+" if g >= 0 else "") + percent(g)
    if g > 0.10:
        return Factor("REVENUE_TREND", title, value, 30, "Выручка растёт")
    if g >= -0.10:
        return Factor("REVENUE_TREND", title, value, 10, "Выручка стабильна")
    if g >= -0.30:
        return Factor("REVENUE_TREND", title, value, -40, "Выручка снизилась")
    return Factor("REVENUE_TREND", title, value, -100, "Выручка сильно снизилась")


def _margin(f: Features) -> Factor:
    title = "Рентабельность продаж"
    m = f.margin
    if m is None:
        return Factor("MARGIN", title, "нет данных", 0)
    value = percent(m, 1)
    if m > 0.15:
        return Factor("MARGIN", title, value, 30, "Высокая рентабельность бизнеса")
    if m >= 0.05:
        return Factor("MARGIN", title, value, 10, "Бизнес прибыльный")
    if m >= 0:
        return Factor("MARGIN", title, value, -10, "Низкая рентабельность")
    return Factor("MARGIN", title, value, -80, "Бизнес работает в убыток")


def _account(f: Features) -> Factor:
    title = "Поступления на счёт в банке"
    if not f.is_bank_client:
        return Factor("ACCOUNT", title, "не клиент банка", 0)
    months = f.inflow_months
    value = f"{months} из 12 мес."
    if f.avg_monthly_inflow is not None:
        value += f", в среднем {rub(f.avg_monthly_inflow)}"
    if months >= 6 and f.inflow_cv is not None and f.inflow_cv > 0.5:
        return Factor("ACCOUNT", title, value, -20, "Нерегулярные поступления на счёт")
    if months >= 12:
        return Factor("ACCOUNT", title, value, 40, "Стабильные поступления на счёт в банке")
    if months >= 6:
        return Factor("ACCOUNT", title, value, 20, "Регулярные поступления на счёт в банке")
    return Factor("ACCOUNT", title, value, 0)


def _tax_debt(f: Features) -> Factor:
    title = "Налоговая задолженность"
    debt = f.tax_debt
    if debt <= 0:
        return Factor("TAX_DEBT", title, "нет", 0)
    if debt <= 100_000:
        return Factor("TAX_DEBT", title, rub(debt), -30, "Есть налоговая задолженность")
    return Factor("TAX_DEBT", title, rub(debt), -100, "Значительная налоговая задолженность")


def _industry(f: Features) -> Factor:
    title = "Отраслевой риск"
    labels = {"LOW": "низкий", "MEDIUM": "средний", "HIGH": "высокий"}
    value = labels[f.industry_risk] + (f" (ОКВЭД {f.okved})" if f.okved else "")
    if f.industry_risk == "LOW":
        return Factor("INDUSTRY", title, value, 10, "Отрасль с низким риском")
    if f.industry_risk == "HIGH":
        return Factor("INDUSTRY", title, value, -40, "Отрасль с повышенным риском")
    return Factor("INDUSTRY", title, value, 0)


def _amount_share(f: Features) -> Factor:
    title = "Доля суммы в годовой выручке"
    share = f.amount_share
    if share is None:
        return Factor("AMOUNT_SHARE", title, "нет данных о выручке", 0)
    value = percent(share)
    if share <= 0.25:
        return Factor("AMOUNT_SHARE", title, value, 20, "Сумма небольшая относительно выручки")
    if share <= 0.50:
        return Factor("AMOUNT_SHARE", title, value, 0)
    return Factor("AMOUNT_SHARE", title, value, -60, "Сумма большая относительно выручки")


FACTORS = (
    _business_age,
    _credit_history,
    _debt_load,
    _revenue_trend,
    _margin,
    _account,
    _tax_debt,
    _industry,
    _amount_share,
)


def risk_class_for(score: int) -> tuple[str, Decimal | None, Decimal]:
    for name, minimum, margin, pd in RISK_CLASSES:
        if score >= minimum:
            return name, margin, pd
    raise AssertionError("unreachable")


def margin_for_class(risk_class: str) -> Decimal | None:
    """Надбавка к ставке по классу риска; для класса E ставки нет."""
    for name, _minimum, margin, _pd in RISK_CLASSES:
        if name == risk_class:
            return margin
    return None


def score(features: Features) -> ScoreResult:
    factors = [factor(features) for factor in FACTORS]
    total = BASE_SCORE + sum(f.points for f in factors)
    risk_class, margin, pd = risk_class_for(total)
    return ScoreResult(score=total, risk_class=risk_class, pd=pd, rate_margin=margin, factors=factors)
