"""Форматирование для текстов, которые видят пользователи."""

from datetime import timedelta, timezone
from decimal import Decimal

# Даты и время для людей — московские: стенд хранит метки в UTC. В Москве с 2014 года нет перехода на летнее
# время, поэтому хватает постоянного смещения и образу не нужна база часовых поясов.
MSK = timezone(timedelta(hours=3), "МСК")


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
    """«1 500 000 ₽»: разряды и знак рубля — через неразрывный пробел (U+00A0), чтобы на узком экране
    сумма не разрывалась и «₽» не уходил на следующую строку. Так же перед «%» и «п.п.» в текстах."""
    value = int(round(Decimal(str(amount))))
    return f"{value:,}".replace(",", "\u00a0") + "\u00a0₽"


def percent(value: float, digits: int = 0) -> str:
    """0,16 → «16 %», с digits — «16,1 %»; перед «%» — неразрывный пробел."""
    return f"{value * 100:.{digits}f}\u00a0%".replace(".", ",")
