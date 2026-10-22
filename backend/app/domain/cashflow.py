"""Прогноз денежного потока по выписке: ожидается ли кассовый разрыв и какой лимит его закроет.

Место в процессе: выписку клиент прикладывает к заявке или присылает по запросу банка. По ней оценивается
выручка (docs/credit-policy.md, «Признаки для оценки»), а здесь — ближайшие три месяца: хватит ли поступлений
на списания. Прогноз не влияет на скоринг и решение: он подсказывает клиенту и аналитику размер овердрафта
или кредитной линии под кассовый разрыв.

Метод намеренно простой и объяснимый: базовый уровень — среднее за последние три месяца, тренд — наклон
прямой по всем месяцам выписки, стартовый остаток — «КонечныйОстаток» из выписки 1С (в CSV его нет, тогда
прогноз показывает, сколько не хватит собственных поступлений). Те же формулы — в демо-режиме
(frontend/src/demo/engine/cashflow.ts), поэтому округление сделано одинаково.
"""

import math
from typing import Any

HORIZON_MONTHS = 3
BASE_WINDOW = 3
GAP_BUFFER = 1.2  # запас к размеру разрыва при подборе лимита
OVERDRAFT_INFLOW_SHARE = 0.4  # как в кредитной политике: лимит овердрафта не больше 40 % среднемесячных поступлений
STEP = 10_000


def rubles(value: float) -> int:
    """До рубля так же, как Math.floor(x + 0.5) в браузере."""
    return int(math.floor(value + 0.5))


def slope(values: list[float]) -> float:
    """Наклон прямой наименьших квадратов, ₽ в месяц. Меньше трёх точек — тренда нет."""
    n = len(values)
    if n < 3:
        return 0.0
    sum_x = sum(range(n))
    sum_y = sum(values)
    sum_xy = sum(x * y for x, y in enumerate(values))
    sum_xx = sum(x * x for x in range(n))
    denominator = n * sum_xx - sum_x * sum_x
    return (n * sum_xy - sum_x * sum_y) / denominator if denominator else 0.0


def next_month(month: str, offset: int) -> str:
    index = int(month[:4]) * 12 + int(month[5:7]) - 1 + offset
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def forecast(months: list[dict[str, Any]], closing_balance: float | None) -> dict[str, Any]:
    """`months` — помесячно от старых к новым: month, inflow, outflow."""
    inflows = [float(m["inflow"]) for m in months]
    outflows = [float(m["outflow"]) for m in months]
    window = min(BASE_WINDOW, len(months))
    base_in = sum(inflows[-window:]) / window
    base_out = sum(outflows[-window:]) / window
    slope_in, slope_out = slope(inflows), slope(outflows)

    balance = closing_balance if closing_balance is not None else 0.0
    min_balance, min_month = balance, None
    projected = []
    for k in range(1, HORIZON_MONTHS + 1):
        inflow = max(0.0, base_in + slope_in * k)
        outflow = max(0.0, base_out + slope_out * k)
        balance += inflow - outflow
        month = next_month(months[-1]["month"], k)
        projected.append(
            {"month": month, "inflow": rubles(inflow), "outflow": rubles(outflow), "balance": rubles(balance)}
        )
        if balance < min_balance:
            min_balance, min_month = balance, month

    gap = max(0.0, -min_balance)
    avg_inflow = sum(inflows) / len(inflows)
    overdraft_cap = math.floor(avg_inflow * OVERDRAFT_INFLOW_SHARE / STEP) * STEP
    if gap > 0:
        amount = math.ceil(gap * GAP_BUFFER / STEP) * STEP
        if amount <= overdraft_cap:
            recommendation = {"product": "OVERDRAFT", "amount": amount, "reason": "GAP_COVERED_BY_OVERDRAFT"}
        else:
            recommendation = {"product": "CREDIT_LINE", "amount": amount, "reason": "GAP_ABOVE_OVERDRAFT_LIMIT"}
    else:
        recommendation = {"product": None, "amount": 0, "reason": "NO_GAP"}

    return {
        "horizon_months": HORIZON_MONTHS,
        "balance_known": closing_balance is not None,
        "deficit_months": [m["month"] for m, i, o in zip(months, inflows, outflows, strict=True) if i - o < 0],
        "trend_inflow": rubles(slope_in),
        "trend_outflow": rubles(slope_out),
        "months": projected,
        "min_balance": rubles(min_balance),
        "min_balance_month": min_month,
        "gap": rubles(gap),
        "overdraft_cap": overdraft_cap,
        "recommendation": recommendation,
    }
