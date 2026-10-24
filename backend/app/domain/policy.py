"""Кредитная политика: допуск, лимит, решение, контрпредложения (docs/credit-policy.md)."""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.domain.catalog import KEY_RATE, PRODUCTS, ProductTerms
from app.domain.enums import Outcome
from app.domain.features import Features
from app.domain.finance import annuity_payment, max_principal, money, overpayment, round_down
from app.domain.scoring import ScoreResult
from app.domain.text import months_text, rub

POLICY_VERSION = "v1.0"

DSCR_MIN = Decimal("1.3")
UNSECURED_REVENUE_SHARE = Decimal("0.5")
SECURED_REVENUE_SHARE = Decimal("1.0")
COLLATERAL_LTV = Decimal("0.8")
OVERDRAFT_INFLOW_SHARE = Decimal("0.4")
MIN_BUSINESS_MONTHS = 3
DIRECTOR_CHANGE_MONTHS = 6
REVENUE_DISCREPANCY = 0.30
ANALYST_LIMIT_TOLERANCE = Decimal("1.2")
FOUR_EYES_AMOUNT = Decimal("30000000")

BAD_COMPANY_STATUSES = {"LIQUIDATING", "REORGANIZING", "BANKRUPTCY", "LIQUIDATED"}
REVOLVING_KINDS = {"OVERDRAFT", "CREDIT_LINE"}

STOP_FACTORS: dict[str, str] = {
    "S01": "Мы не выдаём кредиты компаниям в процессе ликвидации, реорганизации или банкротства",
    "S02": "По данным ФНС руководитель компании дисквалифицирован",
    "S03": "У компании есть просроченный долг по кредитам. Погасите его и подайте заявку снова",
    "S04": "Кредиты доступны бизнесу от 3 месяцев с даты регистрации",
    "S05": "Сейчас мы не можем предложить кредит",
}

FLAGS: dict[str, str] = {
    "F01": "Адрес массовой регистрации",
    "F02": "Есть налоговая задолженность",
    "F03": "Руководитель сменился меньше 6 месяцев назад",
    "F04": "Выручка в заявке отличается от данных источников больше чем на 30\u00a0%",
    "F05": "Внешний источник недоступен после всех повторов",
    "F06": "Текущая просрочка до 30 дней",
    "F07": "Класс риска C или D",
}

REASONS: dict[str, tuple[str, str]] = {
    # код: (для аналитика, для клиента)
    "R01": ("Высокий кредитный риск", "Сейчас мы не можем предложить кредит"),
    "R02": (
        "Недостаточная платёжеспособность",
        "Текущая выручка и долговая нагрузка не позволяют выдать кредит на эту сумму",
    ),
    "R03": ("Негативная кредитная история", "Отказ связан с вашей кредитной историей"),
    "R04": ("Недостоверные данные", "Данные в заявке не подтвердились"),
    "R05": ("Не предоставлены документы", "Мы не получили документы, необходимые для решения"),
    "R06": ("Не соответствует политике банка", "Заявка не соответствует условиям кредитования"),
    "R07": ("Иное", "Отказ по решению специалиста банка"),
}

# Что поможет клиенту после отказа — по коду стоп-фактора или причины (docs/credit-policy.md, «Объяснение решения»).
ADVICE: dict[str, str] = {
    "S01": "Подать заявку можно после завершения ликвидации, реорганизации или процедуры банкротства",
    "S02": "Заявку можно подать после снятия дисквалификации или через 6 месяцев после смены руководителя",
    "S03": (
        "Погасите просроченный долг: бюро кредитных историй обновляет данные за несколько дней, "
        "после этого подайте заявку снова"
    ),
    "S04": "Подайте заявку, когда с даты регистрации бизнеса пройдёт 3 месяца",
    "S05": (
        "Оценку повысят погашение просрочек и налоговой задолженности, снижение долговой нагрузки и рост "
        "выручки. Начать можно с небольшой суммы через несколько месяцев"
    ),
    "R01": (
        "Оценку повысят погашение просрочек и налоговой задолженности, снижение долговой нагрузки и рост "
        "выручки. Начать можно с небольшой суммы через несколько месяцев"
    ),
    "R02": (
        "Уменьшите сумму или увеличьте срок, чтобы платёж укладывался в прибыль бизнеса. "
        "Погашение части текущих кредитов тоже увеличит доступную сумму"
    ),
    "R03": "Через 6 месяцев без просрочек по текущим кредитам можно подать заявку снова",
    "R04": (
        "Проверьте данные в заявке: выручку мы сверяем с отчётностью и оборотами по счёту. Исправьте и подайте снова"
    ),
    "R05": "Приложите запрошенные документы в кабинете и подайте заявку снова",
    "R06": "Выберите другой продукт: подходящие условия видны на шаге подбора",
}

# Совет по оценке риска (S05, R01) называет, что её повысит, — по факторам скоринга заявки (FACTOR_ADVICE).
# Общий текст из ADVICE остаётся, только если отрицательных факторов, на которые клиент может повлиять, нет.
RISK_ADVICE_CODES = {"S05", "R01"}
RISK_ADVICE = "Оценка станет выше, когда {causes}. Начать можно с небольшой суммы через несколько месяцев"
# При этих стоп-факторах совета по оценке риска нет: сначала устраняется сам стоп-фактор, у него свой совет.
BLOCKING_STOP_FACTORS = {"S01", "S02", "S03", "S04"}

# За счёт чего продукт дешевле — для подсказки «как получить ставку ниже».
CHEAPER_WHY: dict[str, str] = {
    "SECURED": "залог недвижимости или оборудования снижает риск банка",
    "CREDIT_LINE": "лимит согласовывается один раз, проценты только на использованную часть",
    "GROWTH": "обычный кредит без залога на срок до 5 лет",
    "OVERDRAFT": "лимит к расчётному счёту на короткие разрывы",
    "EXPRESS": "решение без залога и документов",
}

# Что снизит надбавку за риск — по коду фактора скоринга с отрицательными баллами.
FACTOR_ADVICE: dict[str, str] = {
    "BUSINESS_AGE": "бизнес проработает дольше",
    "CREDIT_HISTORY": "по кредитам не будет просрочек",
    "DEBT_LOAD": "снизится долговая нагрузка, например после погашения части кредитов",
    "REVENUE_TREND": "выручка перестанет снижаться",
    "MARGIN": "вырастет прибыльность бизнеса",
    "ACCOUNT": "поступления на счёт в банке станут регулярными",
    "TAX_DEBT": "будет погашена налоговая задолженность",
    "AMOUNT_SHARE": "сумма будет меньше относительно годовой выручки",
}

LIMIT_PHRASES: dict[str, str] = {
    "PRODUCT_MAX": "Сумма ограничена максимумом продукта",
    "REVENUE": "Сумма ограничена выручкой бизнеса",
    "COLLATERAL": "Сумма ограничена стоимостью залога",
    "DSCR": "Текущие платежи по кредитам и прибыль ограничивают сумму",
    "OVERDRAFT": "Лимит овердрафта — до 40\u00a0% среднемесячных поступлений на счёт",
}

STATEMENT_REQUEST_ITEM = {
    "code": "BANK_STATEMENT",
    "title": "Выписка по расчётному счёту за последние 12 месяцев",
    "hint": "Файл выгрузки из банка в формате 1С (.txt) или таблица CSV. По ней мы оценим выручку.",
}


@dataclass
class Issue:
    code: str
    text: str


@dataclass
class OfferOption:
    kind: str
    product_code: str
    amount: Decimal
    term_months: int
    rate: Decimal
    monthly_payment: Decimal
    overpayment: Decimal
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "product_code": self.product_code,
            "amount": float(self.amount),
            "term_months": self.term_months,
            "rate": float(self.rate),
            "monthly_payment": float(self.monthly_payment),
            "overpayment": float(self.overpayment),
            "note": self.note,
        }


@dataclass
class LimitResult:
    limit: Decimal | None
    binding: str | None
    constraints: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class PolicyDecision:
    outcome: str
    policy_version: str = POLICY_VERSION
    rate: Decimal | None = None
    limit: Decimal | None = None
    limit_binding: str | None = None
    stop_factors: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    reason_codes: list[str] = field(default_factory=list)
    options: list[OfferOption] = field(default_factory=list)
    info_items: list[dict[str, Any]] = field(default_factory=list)
    trace: list[dict[str, Any]] = field(default_factory=list)

    def note(self, rule: str, result: str, detail: str = "") -> None:
        self.trace.append({"rule": rule, "result": result, "detail": detail})


def eligibility_issues(
    product: ProductTerms,
    *,
    business_months: int | None,
    is_bank_client: bool,
    account_months: int,
    amount: Decimal | None = None,
    term_months: int | None = None,
) -> list[Issue]:
    issues: list[Issue] = []
    if business_months is not None:
        if business_months < product.min_business_months:
            age = months_text(product.min_business_months, genitive=True)
            issues.append(Issue("BUSINESS_AGE", f"Доступен бизнесу от {age}"))
        if product.max_business_months is not None and business_months >= product.max_business_months:
            issues.append(Issue("BUSINESS_AGE", "Только для бизнеса младше года"))
    required = product.requires_bank_account_months
    if required is not None and (not is_bank_client or account_months < required):
        issues.append(Issue("BANK_ACCOUNT", f"Доступен клиентам банка с поступлениями на счёт от {required} мес."))
    if amount is not None and not (product.min_amount <= amount <= product.max_amount):
        issues.append(Issue("AMOUNT", f"Сумма от {rub(product.min_amount)} до {rub(product.max_amount)}"))
    if term_months is not None and not (product.min_term <= term_months <= product.max_term):
        if product.min_term == product.max_term:
            issues.append(Issue("TERM", f"Срок {product.min_term} мес."))
        else:
            issues.append(Issue("TERM", f"Срок от {product.min_term} до {product.max_term} мес."))
    return issues


def offer_figures(product: ProductTerms, amount: Decimal, rate: Decimal, term: int) -> tuple[Decimal, Decimal]:
    """Платёж и переплата. Для овердрафта и линии — проценты при полном использовании лимита."""
    if product.kind in REVOLVING_KINDS:
        monthly = money(amount * rate / 1200)
        return monthly, money(monthly * term)
    return annuity_payment(amount, rate, term), overpayment(amount, rate, term)


def compute_limit(
    product: ProductTerms,
    f: Features,
    *,
    rate: Decimal,
    term_months: int,
    collateral_value: Decimal | None,
) -> LimitResult:
    constraints: list[dict[str, Any]] = [{"code": "PRODUCT_MAX", "amount": product.max_amount}]
    if product.kind == "OVERDRAFT":
        if f.avg_monthly_inflow is None:
            return LimitResult(limit=None, binding=None, constraints=constraints)
        constraints.append({"code": "OVERDRAFT", "amount": money(f.avg_monthly_inflow * OVERDRAFT_INFLOW_SHARE)})
    else:
        if f.revenue is None or f.operating_profit_month is None:
            return LimitResult(limit=None, binding=None, constraints=constraints)
        if product.collateral_required:
            constraints.append({"code": "REVENUE", "amount": money(f.revenue * SECURED_REVENUE_SHARE)})
            constraints.append(
                {"code": "COLLATERAL", "amount": money((collateral_value or Decimal(0)) * COLLATERAL_LTV)}
            )
        else:
            constraints.append({"code": "REVENUE", "amount": money(f.revenue * UNSECURED_REVENUE_SHARE)})
        max_payment = f.operating_profit_month / DSCR_MIN - f.existing_payments
        if product.kind in REVOLVING_KINDS:
            # Для линии: проценты и равное погашение основного долга за срок.
            dscr_amount = max_payment / (rate / 1200 + Decimal(1) / term_months) if max_payment > 0 else 0
        else:
            dscr_amount = max_principal(max_payment, rate, term_months)
        constraints.append({"code": "DSCR", "amount": money(dscr_amount), "max_payment": money(max_payment)})
    binding = min(constraints, key=lambda c: c["amount"])
    serialized = [
        {key: float(value) if isinstance(value, Decimal) else value for key, value in c.items()} for c in constraints
    ]
    return LimitResult(limit=round_down(binding["amount"]), binding=binding["code"], constraints=serialized)


def stop_factors(f: Features, s: ScoreResult) -> list[str]:
    found = []
    if f.company_status in BAD_COMPANY_STATUSES:
        found.append("S01")
    if f.director_disqualified:
        found.append("S02")
    if f.current_overdue_days > 30:
        found.append("S03")
    if f.business_months is not None and f.business_months < MIN_BUSINESS_MONTHS:
        found.append("S04")
    if s.risk_class == "E":
        found.append("S05")
    return found


def review_flags(f: Features, s: ScoreResult) -> list[str]:
    found = []
    if f.mass_address:
        found.append("F01")
    if f.tax_debt > 0:
        found.append("F02")
    if f.director_months is not None and f.director_months < DIRECTOR_CHANGE_MONTHS:
        found.append("F03")
    if f.revenue_discrepancy is not None and f.revenue_discrepancy > REVENUE_DISCREPANCY:
        found.append("F04")
    if f.unavailable_sources:
        found.append("F05")
    if 0 < f.current_overdue_days <= 30:
        found.append("F06")
    if s.risk_class in ("C", "D"):
        found.append("F07")
    return found


def rate_for(product: ProductTerms, s: ScoreResult) -> Decimal | None:
    if s.rate_margin is None:
        return None
    return product.base_rate + s.rate_margin


def _option(
    product: ProductTerms, kind: str, amount: Decimal, term: int, rate: Decimal, note: str | None = None
) -> OfferOption:
    monthly, over = offer_figures(product, amount, rate, term)
    return OfferOption(kind, product.code, money(amount), term, rate, monthly, over, note)


def longer_term_option(
    product: ProductTerms,
    f: Features,
    *,
    amount: Decimal,
    term: int,
    rate: Decimal,
    collateral_value: Decimal | None,
) -> OfferOption | None:
    """Та же сумма на более длинный срок, если на каком-то сроке она вписывается в лимит."""
    if product.kind in REVOLVING_KINDS:
        return None
    # Сроки, кратные полугоду, — их проще воспринимать, чем «57 месяцев».
    candidates = sorted({t for t in range(6, product.max_term + 1, 6) if t > term} | {product.max_term} - {term})
    for longer in (t for t in candidates if t > term):
        result = compute_limit(product, f, rate=rate, term_months=longer, collateral_value=collateral_value)
        if result.limit is not None and result.limit >= amount:
            return _option(
                product, "COUNTER", amount, longer, rate, f"Та же сумма на {months_text(longer)} — платёж ниже"
            )
    return None


def decide(
    product: ProductTerms,
    f: Features,
    s: ScoreResult,
    *,
    amount: Decimal,
    term_months: int,
    collateral_value: Decimal | None,
) -> PolicyDecision:
    d = PolicyDecision(outcome=Outcome.MANUAL_REVIEW)

    d.stop_factors = stop_factors(f, s)
    if d.stop_factors:
        d.outcome = Outcome.REJECT
        d.note("Стоп-факторы", "отказ", ", ".join(d.stop_factors))
        return d
    d.note("Стоп-факторы", "нет")

    issues = eligibility_issues(
        product,
        business_months=f.business_months,
        is_bank_client=f.is_bank_client,
        account_months=f.account_months,
        amount=amount,
        term_months=term_months,
    )
    if product.collateral_required and not collateral_value:
        issues.append(Issue("COLLATERAL", "Для продукта нужен залог"))
    if issues:
        d.outcome = Outcome.REJECT
        d.reason_codes = ["R06"]
        d.note("Условия продукта", "не выполнены", "; ".join(i.text for i in issues))
        return d
    d.note("Условия продукта", "выполнены")

    rate = rate_for(product, s)
    d.rate = rate
    limit = compute_limit(product, f, rate=rate, term_months=term_months, collateral_value=collateral_value)
    if limit.limit is None:
        d.outcome = Outcome.NEED_INFO
        d.info_items = [STATEMENT_REQUEST_ITEM]
        d.note("Финансовые данные", "нет источника", "нужна выписка по счёту")
        return d
    d.limit = limit.limit
    d.limit_binding = limit.binding
    d.note("Лимит", rub(limit.limit), LIMIT_PHRASES.get(limit.binding or "", ""))

    if limit.limit < product.min_amount:
        d.outcome = Outcome.REJECT
        d.reason_codes = ["R02"]
        d.note("Лимит не меньше минимальной суммы", "нет", f"минимум {rub(product.min_amount)}")
        return d

    d.flags = review_flags(f, s)
    if d.flags or product.always_manual:
        d.outcome = Outcome.MANUAL_REVIEW
        detail = ", ".join(d.flags) if d.flags else "продукт рассматривает аналитик"
        d.note("Флаги ручного рассмотрения", "есть", detail)
        return d
    d.note("Флаги ручного рассмотрения", "нет")

    offered = min(amount, limit.limit)
    auto_limit = product.auto_limit or Decimal(0)
    if offered > auto_limit:
        d.outcome = Outcome.MANUAL_REVIEW
        d.note("Автолимит", "превышен", f"{rub(offered)} > {rub(auto_limit)}")
        return d
    d.note("Автолимит", "в пределах", rub(auto_limit))

    if offered >= amount:
        d.outcome = Outcome.APPROVE
        d.options = [_option(product, "AS_REQUESTED", amount, term_months, rate)]
        d.note("Решение", "одобрено как запрошено")
        return d

    d.outcome = Outcome.COUNTER
    if amount <= auto_limit:
        longer = longer_term_option(
            product, f, amount=amount, term=term_months, rate=rate, collateral_value=collateral_value
        )
        if longer:
            d.options.append(longer)
    d.options.append(
        _option(product, "COUNTER", offered, term_months, rate, f"Меньшая сумма на {months_text(term_months)}")
    )
    for no, option in enumerate(d.options, start=1):
        option.note = option.note or f"Вариант {no}"
    d.note("Решение", "контрпредложение", f"вариантов: {len(d.options)}")
    return d


def pp(value: Decimal) -> str:
    """Проценты и процентные пункты по-русски: 1,5 / 0 / 5."""
    return format(value.normalize(), "f").replace(".", ",")


def rate_breakdown(product: ProductTerms, risk_margin: Decimal, *, offer_rate: Decimal | None = None) -> dict[str, Any]:
    """Из чего складывается ставка: ключевая + спред продукта + надбавка за риск (+ решение аналитика)."""
    spread = product.base_rate - KEY_RATE
    policy_rate = product.base_rate + risk_margin
    adjustment = (offer_rate - policy_rate) if offer_rate is not None else Decimal(0)
    return {
        "key_rate": KEY_RATE,
        "product_spread": spread,
        "risk_margin": risk_margin,
        "adjustment": adjustment,
        "rate": policy_rate + adjustment,
    }


def factor_causes(factors: list[dict[str, Any]], limit: int = 2) -> list[str]:
    """Что улучшит оценку: продолжения фраз из FACTOR_ADVICE для факторов скоринга с наибольшим отрицательным
    вкладом. Отраслевой риск совета не получает — отрасль клиент не меняет."""
    negative = sorted((x for x in factors if x.get("points", 0) < 0), key=lambda x: x["points"])
    return [FACTOR_ADVICE[x["code"]] for x in negative if x.get("code") in FACTOR_ADVICE][:limit]


def rate_hints(
    product: ProductTerms,
    f: Features,
    *,
    risk_margin: Decimal,
    factors: list[dict[str, Any]],
    purpose: str | None,
    rate: Decimal,
) -> list[dict[str, Any]]:
    """Как получить ставку ниже: более дешёвые продукты под ту же цель, доступные компании, и что снизит надбавку."""
    hints: list[dict[str, Any]] = []
    for other in sorted(PRODUCTS, key=lambda item: item.base_rate):
        if other.code == product.code:
            continue
        other_rate = other.base_rate + risk_margin
        if other_rate >= rate:
            continue
        purposes = {str(getattr(item, "value", item)) for item in other.purposes}
        if purpose and purposes and purpose not in purposes:
            continue
        issues = eligibility_issues(
            other,
            business_months=f.business_months,
            is_bank_client=f.is_bank_client,
            account_months=f.account_months,
            amount=f.amount or None,
        )
        if issues:
            continue
        why = CHEAPER_WHY.get(other.code, "ставка ниже за счёт условий продукта")
        text = f"{other.name} — {pp(other_rate)}\u00a0%: {why}"
        saving: Decimal | None = None
        if f.term_months and f.term_months > other.max_term:
            text += f" (срок до {months_text(other.max_term)})"
        elif f.amount and f.term_months and product.kind not in REVOLVING_KINDS and other.kind not in REVOLVING_KINDS:
            # Та же сумма и срок: насколько меньше переплата за весь срок (только для кредитов с графиком)
            _, current = offer_figures(product, f.amount, rate, f.term_months)
            _, other_over = offer_figures(other, f.amount, other_rate, f.term_months)
            saving = money(current - other_over) if current > other_over else None
        hints.append(
            {
                "kind": "product",
                "text": text,
                "product_code": other.code,
                "product_name": other.name,
                "rate": other_rate,
                "saving": saving,
            }
        )
    if risk_margin > 0:
        causes = factor_causes(factors)
        if causes:
            text = f"Надбавка за риск {pp(risk_margin)}\u00a0п.п. станет ниже, когда {' и '.join(causes)}"
        else:
            text = (
                f"Надбавка за риск {pp(risk_margin)}\u00a0п.п. снижается по мере роста срока работы бизнеса "
                "и накопления кредитной истории без просрочек"
            )
        hints.append(
            {"kind": "risk", "text": text, "product_code": None, "product_name": None, "rate": None, "saving": None}
        )
    return hints


def decline_alternatives(
    product: ProductTerms,
    f: Features,
    *,
    risk_margin: Decimal,
    purpose: str | None,
    term_months: int,
) -> list[dict[str, Any]]:
    """«Вам может подойти» после отказа по условиям продукта или лимиту: продукты под ту же цель и доступная сумма."""
    result: list[dict[str, Any]] = []
    for other in sorted(PRODUCTS, key=lambda item: item.base_rate):
        if other.code == product.code or other.collateral_required or other.always_manual:
            continue
        purposes = {str(getattr(item, "value", item)) for item in other.purposes}
        if purpose and purposes and purpose not in purposes:
            continue
        if eligibility_issues(
            other, business_months=f.business_months, is_bank_client=f.is_bank_client, account_months=f.account_months
        ):
            continue
        rate = other.base_rate + risk_margin
        term = min(max(term_months, other.min_term), other.max_term)
        limit = compute_limit(other, f, rate=rate, term_months=term, collateral_value=None)
        if limit.limit is None or limit.limit < other.min_amount:
            continue
        result.append(
            {
                "product_code": other.code,
                "product_name": other.name,
                "max_amount": min(limit.limit, other.max_amount),
                "term_months": term,
                "rate": rate,
            }
        )
    return result[:2]


def next_steps(
    stop_factor_codes: list[str], reason_codes: list[str], factors: list[dict[str, Any]] | None = None
) -> list[str]:
    """Что поможет после отказа: по одному совету на код, без повторов.

    Совет по оценке риска (S05, R01) собирается из отрицательных факторов скоринга заявки (factors), общий текст —
    только если таких факторов нет. Если есть стоп-фактор S01–S04, этого совета нет: сначала нужно устранить сам
    стоп-фактор, а совет по оценке повторял бы его совет или говорил о том, чего у компании нет.
    """
    blocked = any(code in BLOCKING_STOP_FACTORS for code in stop_factor_codes)
    causes = factor_causes(factors or [])
    result: list[str] = []
    for code in [*stop_factor_codes, *reason_codes]:
        if code in RISK_ADVICE_CODES:
            if blocked:
                continue
            text = RISK_ADVICE.format(causes=" и ".join(causes)) if causes else ADVICE.get(code)
        else:
            text = ADVICE.get(code)
        if text and text not in result:
            result.append(text)
    return result


def check_analyst_terms(
    product: ProductTerms,
    *,
    amount: Decimal,
    term_months: int,
    rate: Decimal,
    limit: Decimal | None,
    min_rate: Decimal | None,
    comment: str | None,
) -> list[str]:
    """Проверка решения аналитика по границам полномочий. Возвращает список нарушений."""
    errors = []
    if not (product.min_amount <= amount <= product.max_amount):
        errors.append(f"Сумма должна быть от {rub(product.min_amount)} до {rub(product.max_amount)}")
    if not (product.min_term <= term_months <= product.max_term):
        errors.append(f"Срок должен быть от {product.min_term} до {product.max_term} мес.")
    if min_rate is not None and rate < min_rate:
        errors.append(f"Ставка не может быть ниже расчётной: {pp(min_rate)}\u00a0%")
    if limit is not None:
        if amount > limit * ANALYST_LIMIT_TOLERANCE:
            errors.append(f"Сумма превышает расчётный лимит {rub(limit)} больше чем на 20\u00a0%")
        elif amount > limit and not (comment and comment.strip()):
            errors.append("Сумма выше расчётного лимита — добавьте комментарий с обоснованием")
    return errors
