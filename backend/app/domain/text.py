"""Форматирование для текстов, которые видят пользователи."""

from decimal import Decimal


def plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(n)
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def months_text(months: int) -> str:
    years, rest = divmod(months, 12)
    parts = []
    if years:
        parts.append(f"{years} {plural(years, 'год', 'года', 'лет')}")
    if rest or not years:
        parts.append(f"{rest} мес.")
    return " ".join(parts)


def rub(amount: Decimal | float | int) -> str:
    value = int(round(Decimal(str(amount))))
    return f"{value:,}".replace(",", " ") + " ₽"


def percent(value: float, digits: int = 0) -> str:
    return f"{value * 100:.{digits}f}%".replace(".", ",")
