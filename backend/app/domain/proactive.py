"""Предварительные предложения на главной: что банк готов дать клиенту по уже известным данным.

Организаторы: проактивные рекомендации — возможное дополнение, а не обязанность (ответ 26). Считается по тем же
правилам кредитной политики, что и лимит в заявке, но без кредитной истории (на запрос в БКИ нужно согласие
клиента) и без заявки: источники — ЕГРЮЛ/ЕГРИП, отчётность ГИР БО и поступления на счёт в банке. Поэтому
предложение предварительное: точные условия — после проверки по заявке. Те же формулы — в демо-режиме
(frontend/src/demo/engine/proactive.ts).
"""

from typing import Any

from app.domain.catalog import ProductTerms
from app.domain.features import Features
from app.domain.finance import round_down
from app.domain.policy import compute_limit, eligibility_issues, offer_figures
from app.domain.text import months_text, rub

CANDIDATES = ("OVERDRAFT", "GROWTH", "CREDIT_LINE", "EXPRESS")
TYPICAL_TERM = 36  # срок, на который считается предварительный лимит кредита
PURPOSES = {
    "OVERDRAFT": "CASH_GAP",
    "CREDIT_LINE": "WORKING_CAPITAL",
    "GROWTH": "WORKING_CAPITAL",
    "EXPRESS": "WORKING_CAPITAL",
}

NOTE_PRELIMINARY = "Предварительно, без учёта кредитной истории. Точные условия — после проверки по заявке."
NOTE_NO_DATA = (
    "Чтобы рассчитать предложение заранее, нужна отчётность или поступления на счёт за три месяца и больше. "
    "Подайте заявку — приложите выписку из другого банка, и мы оценим выручку по ней."
)


def proactive_offers(products: dict[str, ProductTerms], f: Features) -> list[dict[str, Any]]:
    """Овердрафт (если доступен) и один кредитный продукт с наибольшей суммой в пределах автолимита."""
    if f.company_status != "ACTIVE" or f.revenue is None:
        return []
    found = []
    for code in CANDIDATES:
        product = products.get(code)
        if product is None:
            continue
        issues = eligibility_issues(
            product,
            business_months=f.business_months,
            is_bank_client=f.is_bank_client,
            account_months=f.account_months,
        )
        if issues:
            continue
        term = min(max(TYPICAL_TERM, product.min_term), product.max_term)
        limit = compute_limit(product, f, rate=product.base_rate, term_months=term, collateral_value=None).limit
        if limit is None:
            continue
        cap = product.auto_limit if product.auto_limit is not None else product.max_amount
        amount = round_down(min(limit, cap))
        if amount < product.min_amount:
            continue
        monthly, _ = offer_figures(product, amount, product.base_rate, term)
        found.append(
            {
                "product_code": code,
                "product_name": product.name,
                "kind": product.kind,
                "purpose": PURPOSES[code],
                "amount": float(amount),
                "term_months": term,
                "rate_from": float(product.base_rate),
                "monthly_payment": float(monthly),
            }
        )
    overdraft = [o for o in found if o["product_code"] == "OVERDRAFT"]
    loans = sorted((o for o in found if o["product_code"] != "OVERDRAFT"), key=lambda o: -o["amount"])
    return overdraft[:1] + loans[:1]


def proactive_facts(f: Features) -> list[str]:
    """На чём основано предложение — простыми словами, по тем же признакам, что и в досье."""
    facts = []
    if f.business_months is not None:
        facts.append(f"Бизнес работает {months_text(f.business_months)}")
    if f.revenue is not None and f.revenue_source == "GIRBO":
        facts.append(f"Выручка по отчётности — {rub(f.revenue)} в год")
        if f.revenue_growth is not None and abs(f.revenue_growth) >= 0.05:
            change = "выросла" if f.revenue_growth > 0 else "снизилась"
            facts.append(f"Выручка {change} на {round(abs(f.revenue_growth) * 100)} % за год")
    if f.is_bank_client and f.avg_monthly_inflow is not None and f.inflow_months >= 3:
        facts.append(f"Поступления на счёт — в среднем {rub(f.avg_monthly_inflow)} в месяц")
    return facts


def proactive_note(f: Features, offers: list[dict[str, Any]]) -> str | None:
    if offers:
        return NOTE_PRELIMINARY
    if f.company_status == "ACTIVE" and f.revenue is None:
        return NOTE_NO_DATA
    return None
