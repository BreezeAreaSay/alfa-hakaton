"""Форматирование для текстов, которые видят пользователи."""

from decimal import Decimal


def plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(n)
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def months_text(months: int, *, genitive: bool = False) -> str:
    """«2 года 3 мес.»; genitive — после предлогов «от» и «до»: «от 1 года»."""
    years, rest = divmod(months, 12)
    parts = []
    if years:
        forms = ("года", "лет", "лет") if genitive else ("год", "года", "лет")
        parts.append(f"{years} {plural(years, *forms)}")
    if rest or not years:
        parts.append(f"{rest} мес.")
    return " ".join(parts)


def rub(amount: Decimal | float | int) -> str:
    value = int(round(Decimal(str(amount))))
    return f"{value:,}".replace(",", " ") + " ₽"


def percent(value: float, digits: int = 0) -> str:
    return f"{value * 100:.{digits}f}%".replace(".", ",")
