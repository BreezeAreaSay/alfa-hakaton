"""Ручное рассмотрение: приоритет заявки в очереди аналитиков и выбор аналитика при автораспределении.

Правила и их смысл — в docs/process.md, «Очередь аналитиков».
"""

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from decimal import Decimal

from app.domain.enums import AppStatus, Priority
from app.domain.text import plural

# Высокий приоритет: срок рассмотрения истёк или до него осталось меньше стольких часов
URGENT_HOURS = 4
# Средний приоритет: крупная сумма…
LARGE_AMOUNT_MLN = 10
LARGE_AMOUNT = Decimal(LARGE_AMOUNT_MLN) * 1_000_000
# …или флаги, по которым аналитику нужно что-то проверить или запросить у клиента: чем раньше он их увидит,
# тем раньше уйдёт запрос. F07 (класс риска C или D) — оценка риска, а не конкретный вопрос, и приоритет не
# повышает; F05 разобран ниже
ATTENTION_FLAGS = ("F01", "F02", "F03", "F04", "F06")
# Источник не ответил за отведённое время: аналитик перезапустит проверку, когда источник восстановится,
# а до тех пор делать по заявке нечего
SOURCE_FLAG = "F05"

# Порядок в очереди: сначала высокий приоритет, внутри приоритета — по сроку рассмотрения
PRIORITY_RANK: dict[str, int] = {Priority.HIGH: 0, Priority.MEDIUM: 1, Priority.NORMAL: 2}


def review_priority(
    status: str,
    *,
    now: datetime,
    sla_due_at: datetime | None,
    amount: Decimal,
    flags: Iterable[str],
) -> tuple[Priority | None, list[str]]:
    """Приоритет заявки на ручном рассмотрении и причины для аналитика; у других статусов приоритета нет."""
    if status != AppStatus.MANUAL_REVIEW:
        return None, []
    flags = list(flags)
    if SOURCE_FLAG in flags:
        return Priority.NORMAL, ["Ждём ответа источника"]

    urgent: list[str] = []
    if sla_due_at is not None:
        if sla_due_at < now:
            urgent.append("Срок рассмотрения истёк")
        elif sla_due_at - now < timedelta(hours=URGENT_HOURS):
            hours = plural(URGENT_HOURS, "часа", "часов", "часов")
            urgent.append(f"До конца срока меньше {URGENT_HOURS} {hours}")

    important: list[str] = []
    if amount >= LARGE_AMOUNT:
        important.append(f"Сумма от {LARGE_AMOUNT_MLN} млн ₽")
    attention = [code for code in flags if code in ATTENTION_FLAGS]
    if len(attention) == 1:
        important.append(f"Флаг {attention[0]} требует проверки")
    elif attention:
        important.append(f"Флаги {', '.join(attention)} требуют проверки")

    if urgent:
        return Priority.HIGH, urgent + important
    if important:
        return Priority.MEDIUM, important
    return Priority.NORMAL, []


def pick_analyst(loads: Mapping[str, int]) -> str | None:
    """Кому назначить заявку: аналитику с наименьшим числом заявок на ручном рассмотрении, при равенстве — первому
    по логину. loads — логин → число заявок; если аналитиков нет, назначать некому."""
    if not loads:
        return None
    return min(loads, key=lambda login: (loads[login], login))
