"""Финансовые расчёты: аннуитет, обратный расчёт суммы, график платежей."""

import calendar
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")
ROUNDING_STEP = Decimal("10000")


def money(value: Decimal | float | int) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def monthly_rate(annual_rate_percent: Decimal) -> Decimal:
    return Decimal(annual_rate_percent) / Decimal(1200)


def annuity_factor(annual_rate_percent: Decimal, term_months: int) -> Decimal:
    """Сумма кредита, которую обслуживает платёж в 1 ₽ в месяц."""
    i = monthly_rate(annual_rate_percent)
    if i == 0:
        return Decimal(term_months)
    return (1 - (1 + i) ** -term_months) / i


def annuity_payment(amount: Decimal, annual_rate_percent: Decimal, term_months: int) -> Decimal:
    return money(Decimal(amount) / annuity_factor(annual_rate_percent, term_months))


def max_principal(payment: Decimal, annual_rate_percent: Decimal, term_months: int) -> Decimal:
    if payment <= 0:
        return Decimal(0)
    return money(Decimal(payment) * annuity_factor(annual_rate_percent, term_months))


def overpayment(amount: Decimal, annual_rate_percent: Decimal, term_months: int) -> Decimal:
    return money(annuity_payment(amount, annual_rate_percent, term_months) * term_months - Decimal(amount))


def round_down(amount: Decimal, step: Decimal = ROUNDING_STEP) -> Decimal:
    if amount <= 0:
        return Decimal(0)
    return (Decimal(amount) / step).quantize(Decimal(1), rounding=ROUND_DOWN) * step


@dataclass(frozen=True)
class ScheduleRow:
    n: int
    due_date: date
    payment: Decimal
    principal: Decimal
    interest: Decimal
    balance: Decimal


def add_months(start: date, months: int) -> date:
    year, month = divmod(start.month - 1 + months, 12)
    year += start.year
    return date(year, month + 1, min(start.day, calendar.monthrange(year, month + 1)[1]))


def payment_schedule(amount: Decimal, annual_rate_percent: Decimal, term_months: int, start: date) -> list[ScheduleRow]:
    """Аннуитетный график. Последний платёж корректируется на остаток от округлений."""
    i = monthly_rate(annual_rate_percent)
    payment = annuity_payment(amount, annual_rate_percent, term_months)
    balance = money(amount)
    rows: list[ScheduleRow] = []
    for n in range(1, term_months + 1):
        interest = money(balance * i)
        principal = payment - interest
        if n == term_months:
            principal = balance
        balance = money(balance - principal)
        rows.append(
            ScheduleRow(
                n=n,
                due_date=add_months(start, n),
                payment=money(principal + interest),
                principal=money(principal),
                interest=interest,
                balance=balance,
            )
        )
    return rows
