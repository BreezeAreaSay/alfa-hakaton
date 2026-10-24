"""Обоснование решения по заявке для аудита: PDF с данными источников, скорингом, политикой и решениями людей.

Содержимое собирается из сохранённых результатов шагов конвейера, скоринга и решений — внешние системы заново
не опрашиваются. Сборка разделена на два шага: ``collect`` строит содержимое из моделей в простые словари,
``render`` рисует по ним PDF теми же шрифтами и стилями, что кредитный договор (services/documents.py).
"""

import io
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.catalog import ProductTerms
from app.domain.enums import DecisionKind, Outcome, Role, StepCode, StepStatus
from app.domain.features import Features
from app.domain.labels import COMPANY_STATUS_LABELS, DOCUMENT_LABELS, PURPOSE_LABELS, STATUS_LABELS, STEP_LABELS
from app.domain.policy import (
    FLAGS,
    LIMIT_PHRASES,
    POLICY_VERSION,
    REASONS,
    STOP_FACTORS,
    check_analyst_terms,
    compute_limit,
    pp,
)
from app.domain.scoring import BASE_SCORE, SCORING_VERSION, margin_for_class
from app.domain.text import months_text, rub
from app.models import Application, Decision, Document, InfoRequest, Loan, Offer, Signature, StatusHistory, User
from app.pipeline.steps import latest_statement, run_results
from app.services.documents import _fonts, _styles, _table
from app.services.views import latest_scoring

# Время в документе — московское: стенд хранит метки в UTC, а читает документ сотрудник банка
MSK = timezone(timedelta(hours=3), "МСК")

# Источники в порядке конвейера; скоринг и решение описаны отдельными разделами
SOURCE_STEPS: tuple[StepCode, ...] = (
    StepCode.DATA_CHECK,
    StepCode.EGRUL,
    StepCode.FNS,
    StepCode.GIRBO,
    StepCode.BKI,
    StepCode.BANK,
)

SOURCE_STATE: dict[str, str] = {
    StepStatus.DONE: "получено",
    StepStatus.SKIPPED: "не требуется",
    StepStatus.RUNNING: "запрашиваем",
    StepStatus.WAITING: "ждём ответ",
    StepStatus.FAILED: "недоступен",
    StepStatus.PENDING: "в очереди",
}

OUTCOME_LABELS: dict[str, str] = {
    Outcome.APPROVE: "Одобрено",
    Outcome.COUNTER: "Контрпредложение",
    Outcome.REJECT: "Отказ",
    Outcome.NEED_INFO: "Запрошена информация",
    Outcome.MANUAL_REVIEW: "Передано аналитику",
}

CONSTRAINT_LABELS: dict[str, str] = {
    "PRODUCT_MAX": "Максимум продукта",
    "REVENUE": "По выручке",
    "COLLATERAL": "По залогу (80% стоимости)",
    "DSCR": "По платёжеспособности (DSCR ≥ 1,3)",
    "OVERDRAFT": "40% поступлений на счёт",
}

OFFER_STATUS: dict[str, str] = {
    "ACTIVE": "Действует",
    "ACCEPTED": "Принято клиентом",
    "DECLINED": "Клиент отказался",
    "EXPIRED": "Истёк срок",
    "VOID": "Аннулировано",
}

INFO_STATUS: dict[str, str] = {
    "OPEN": "Ждём ответ",
    "ANSWERED": "Ответ получен",
    "EXPIRED": "Срок истёк",
    "CANCELLED": "Отменён",
}

ACTOR_LABELS: dict[str, str] = {
    "CLIENT": "Клиент",
    "SYSTEM": "Система",
    "UNDERWRITER": "Аналитик",
    "ADMIN": "Администратор",
}

ROLE_LABELS: dict[str, str] = {
    Role.UNDERWRITER: "кредитный аналитик",
    Role.ADMIN: "администратор",
    Role.CLIENT: "клиент",
}

LEGAL_FORMS: dict[str, str] = {
    "OOO": "Общество с ограниченной ответственностью",
    "IP": "Индивидуальный предприниматель",
}

REVENUE_SOURCES: dict[str, str] = {
    "GIRBO": "по отчётности ГИР БО",
    "BANK": "по оборотам на счёте в банке",
    "STATEMENT": "по выписке клиента",
}

SIGN_METHODS: dict[str, str] = {
    "PEP_PASSWORD": "Простая электронная подпись: подтверждение паролем",
    "BANK_AUTO": "Подпись банка проставлена автоматически",
}

Facts = list[list[str]]


# ---------------------------------------------------------------- форматирование


def when(value: datetime | None) -> str:
    if value is None:
        return "—"
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(MSK).strftime("%d.%m.%Y %H:%M")


def day(value: Any) -> str:
    if value in (None, ""):
        return "—"
    if isinstance(value, datetime):
        return value.astimezone(MSK).strftime("%d.%m.%Y")
    if isinstance(value, date):
        return value.strftime("%d.%m.%Y")
    try:
        return date.fromisoformat(str(value)[:10]).strftime("%d.%m.%Y")
    except ValueError:
        return str(value)


def percent(value: Decimal | float | int | None) -> str:
    """Ставка или доля в процентах по-русски: «20,5 %»."""
    if value is None:
        return "—"
    return f"{pp(Decimal(str(value)))} %"


def signed(points: int) -> str:
    return f"+{points}" if points > 0 else str(points)


def yes_no(flag: Any) -> str:
    return "да" if flag else "нет"


def legal_form(code: str | None) -> str:
    return LEGAL_FORMS.get(code or "", "—")


# ---------------------------------------------------------------- входные данные по источникам


def data_check_facts(result: dict[str, Any]) -> Facts:
    """Проверки заявки одной строкой: перечисляются только непройденные, остальные — счётчиком."""
    checks = result.get("checks") or []
    failed = [check.get("title", "—") for check in checks if not check.get("ok")]
    passed = [check.get("title", "—") for check in checks if check.get("ok")]
    facts: Facts = []
    if failed:
        facts.append(["Не пройдены", "; ".join(failed)])
    if passed:
        facts.append(["Пройдены", f"{len(passed)} из {len(checks)}: " + "; ".join(passed)])
    return facts


def egrul_facts(result: dict[str, Any]) -> Facts:
    if result.get("found") is False:
        return [["Результат", "Компания не найдена в реестре"]]
    director = result.get("director") or {}
    okved = result.get("okved")
    status = result.get("status")
    return [
        ["Наименование", result.get("name") or "—"],
        ["Форма", legal_form(result.get("legal_form"))],
        ["ОГРН", result.get("ogrn") or "—"],
        ["Дата регистрации", day(result.get("registration_date"))],
        ["Статус", COMPANY_STATUS_LABELS.get(status or "", status or "—")],
        ["ОКВЭД", f"{okved} · {result.get('okved_name') or ''}".strip(" ·") if okved else "—"],
        ["Адрес", result.get("address") or "—"],
        [
            "Руководитель",
            f"{director.get('name')}, с {day(director.get('since'))}" if director.get("name") else "—",
        ],
    ]


def fns_facts(result: dict[str, Any]) -> Facts:
    debt = result.get("tax_debt") or 0
    facts = [
        ["Налоговая задолженность", rub(debt) if debt > 0 else "нет"],
        ["Адрес массовой регистрации", yes_no(result.get("mass_address"))],
        ["Дисквалификация руководителя", yes_no(result.get("director_disqualified"))],
    ]
    if result.get("employees") is not None:
        facts.append(["Сотрудников", str(result["employees"])])
    if result.get("tax_regime"):
        facts.append(["Налоговый режим", str(result["tax_regime"])])
    return facts


def girbo_block(result: dict[str, Any]) -> tuple[Facts, dict[str, Any] | None]:
    years = sorted(result.get("years") or [], key=lambda y: y.get("year", 0), reverse=True)
    if not result.get("available") or not years:
        return [["Результат", result.get("reason") or "Отчётность в ГИР БО не найдена"]], None
    rows = []
    for y in years:
        revenue = y.get("revenue") or 0
        sales_profit = y.get("sales_profit") or 0
        margin = percent(round(sales_profit / revenue * 100, 1)) if revenue else "—"
        rows.append([str(y.get("year")), rub(revenue), rub(sales_profit), rub(y.get("net_profit") or 0), margin])
    header = ["Год", "Выручка", "Прибыль от продаж", "Чистая прибыль", "Рентабельность продаж"]
    return [], {"header": header, "rows": rows, "widths": [16, 40, 40, 40, 38], "numeric": [1, 2, 3, 4]}


def bki_block(result: dict[str, Any]) -> tuple[Facts, dict[str, Any] | None]:
    loans = result.get("loans") or []
    max_overdue = int(result.get("max_overdue_days_24m") or 0)
    current = int(result.get("current_overdue_days") or 0)
    payment = sum(float(loan.get("monthly_payment") or 0) for loan in loans)
    balance = sum(float(loan.get("balance") or 0) for loan in loans)
    facts = [
        ["Кредитная история", "есть" if result.get("has_history") else "нет"],
        ["Максимальная просрочка за 24 мес.", f"{max_overdue} дн." if max_overdue else "нет"],
        ["Текущая просрочка", f"{current} дн." if current else "нет"],
        [
            "Действующие кредиты",
            f"{len(loans)}, платежи {rub(payment)} в мес., остаток {rub(balance)}" if loans else "нет",
        ],
    ]
    if not loans:
        return facts, None
    rows = [
        [
            loan.get("lender") or "—",
            loan.get("kind") or "—",
            rub(loan.get("amount") or 0),
            rub(loan.get("balance") or 0),
            rub(loan.get("monthly_payment") or 0),
            day(loan.get("opened_at")),
        ]
        for loan in loans
    ]
    header = ["Кредитор", "Вид", "Сумма", "Остаток", "Платёж в месяц", "Открыт"]
    return facts, {"header": header, "rows": rows, "widths": [38, 28, 28, 28, 28, 24], "numeric": [2, 3, 4]}


def bank_block(result: dict[str, Any]) -> tuple[Facts, dict[str, Any] | None]:
    if not result.get("is_client"):
        return [["Клиент банка", "нет — данных об оборотах нет, выручка оценивается по отчётности или выписке"]], None
    months = result.get("months") or []
    total = sum(float(m.get("inflow") or 0) for m in months)
    with_inflow = sum(1 for m in months if float(m.get("inflow") or 0) > 0)
    facts = [
        ["Клиент банка", "да"],
        ["Счёт открыт", day(result.get("account_opened_at"))],
        ["Месяцев с поступлениями", f"{with_inflow} из {len(months)}"],
        ["Поступления в среднем за месяц", rub(total / len(months)) if months else "—"],
    ]
    if not months:
        return facts, None
    # Двенадцать месяцев в две колонки, чтобы таблица не растягивалась на полстраницы
    cells = [[m.get("month") or "—", rub(m.get("inflow") or 0)] for m in months]
    half = (len(cells) + 1) // 2
    rows = [cells[i] + (cells[i + half] if i + half < len(cells) else ["", ""]) for i in range(half)]
    header = ["Месяц", "Поступления", "Месяц", "Поступления"]
    return facts, {"header": header, "rows": rows, "widths": [30, 57, 30, 57], "numeric": [1, 3]}


def statement_facts(parsed: dict[str, Any]) -> Facts:
    facts = [
        ["Период", f"{day(parsed.get('period_from'))} — {day(parsed.get('period_to'))}"],
        ["Операций", str(parsed.get("operations") or 0)],
        ["Поступления в среднем за месяц", rub(parsed.get("avg_monthly_inflow") or 0)],
        ["Всего поступлений", rub(parsed.get("total_inflow") or 0)],
    ]
    if parsed.get("closing_balance") is not None:
        facts.append(["Остаток на конец периода", rub(parsed["closing_balance"])])
    return facts


def source_section(
    code: str,
    status: str,
    result: dict[str, Any] | None,
    error: str | None,
    attempts: int,
    finished_at: datetime | None,
) -> dict[str, Any]:
    """Один источник: заголовок шага, состояние, факты и таблица из сохранённого ответа."""
    facts: Facts = []
    table: dict[str, Any] | None = None
    if result:
        if code == StepCode.DATA_CHECK:
            facts = data_check_facts(result)
        elif code == StepCode.EGRUL:
            facts = egrul_facts(result)
        elif code == StepCode.FNS:
            facts = fns_facts(result)
        elif code == StepCode.GIRBO:
            facts, table = girbo_block(result)
        elif code == StepCode.BKI:
            facts, table = bki_block(result)
        elif code == StepCode.BANK:
            facts, table = bank_block(result)
    meta = SOURCE_STATE.get(status, status)
    if finished_at:
        meta += f", ответ получен {when(finished_at)}"
    if attempts > 1:
        meta += f", попыток: {attempts}"
    note = None
    if status in (StepStatus.WAITING, StepStatus.FAILED):
        note = f"Источник не ответил: {error or 'нет ответа'}. " + (
            "Заявка передана аналитику с флагом F05." if status == StepStatus.FAILED else "Повторяем автоматически."
        )
    elif not result and status == StepStatus.PENDING:
        note = "Запрос ещё не выполнялся."
    return {"title": STEP_LABELS[code]["title"], "meta": meta, "facts": facts, "table": table, "note": note}


# ---------------------------------------------------------------- скоринг и политика


def scoring_content(
    *,
    version: str,
    score: int,
    risk_class: str,
    pd: Decimal | float,
    factors: list[dict[str, Any]],
    features: dict[str, Any],
) -> dict[str, Any]:
    margin = margin_for_class(risk_class)
    total = sum(int(f.get("points", 0)) for f in factors)
    f = features
    key_features: Facts = []
    if f.get("revenue") is not None:
        source = REVENUE_SOURCES.get(f.get("revenue_source") or "", "")
        key_features.append(["Выручка за год", f"{rub(f['revenue'])} {source}".strip()])
    if f.get("operating_profit_month") is not None:
        key_features.append(["Операционная прибыль в месяц", rub(f["operating_profit_month"])])
    if f.get("existing_payments"):
        key_features.append(["Платежи по действующим кредитам", f"{rub(f['existing_payments'])} в мес."])
    if f.get("dscr_current") is not None:
        key_features.append(["Покрытие платежей прибылью (DSCR)", f"{f['dscr_current']:.2f}".replace(".", ",")])
    if f.get("avg_monthly_inflow") is not None:
        key_features.append(["Поступления на счёт в среднем за месяц", rub(f["avg_monthly_inflow"])])
    if f.get("declared_revenue"):
        discrepancy = f.get("revenue_discrepancy")
        note = f", расхождение с источниками {percent(round(discrepancy * 100, 1))}" if discrepancy is not None else ""
        key_features.append(["Выручка, заявленная клиентом", f"{rub(f['declared_revenue'])}{note}"])
    if f.get("unavailable_sources"):
        key_features.append(["Недоступные источники", ", ".join(f["unavailable_sources"])])
    return {
        "version": version,
        "score": score,
        "risk_class": risk_class,
        "pd": percent(pd),
        "margin": f"+{pp(margin)} п.п. к базовой ставке продукта" if margin is not None else "ставка не назначается",
        "total": f"базовый балл {BASE_SCORE} {'+' if total >= 0 else '−'} {abs(total)} по факторам = {score}",
        "factors": [
            [
                str(x.get("title", x.get("code", ""))),
                str(x.get("value", "")),
                signed(int(x.get("points", 0))),
                x.get("phrase") or "—",
            ]
            for x in factors
        ],
        "features": key_features,
    }


def limit_content(
    terms: ProductTerms,
    features: Features,
    *,
    rate: Decimal,
    term_months: int,
    collateral_value: Decimal | None,
    decided_limit: Decimal | None,
) -> dict[str, Any] | None:
    """Расчёт лимита по сохранённым признакам: все ограничения и то, которое определило лимит."""
    result = compute_limit(terms, features, rate=rate, term_months=term_months, collateral_value=collateral_value)
    rows = []
    for item in result.constraints:
        note = f"платёж не больше {rub(item['max_payment'])} в месяц" if item.get("max_payment") is not None else ""
        rows.append(
            [
                CONSTRAINT_LABELS.get(item["code"], item["code"]),
                rub(item["amount"]),
                note,
                item["code"] == result.binding,
            ]
        )
    limit = decided_limit if decided_limit is not None else result.limit
    recomputed = None
    if decided_limit is not None and result.limit is not None and Decimal(decided_limit) != result.limit:
        recomputed = f"Пересчёт по текущей версии политики даёт {rub(result.limit)}"
    return {
        "amount": rub(limit) if limit is not None else "не рассчитан: нет данных о выручке",
        "phrase": LIMIT_PHRASES.get(result.binding or "", ""),
        "rate": f"{percent(rate)} годовых",
        "constraints": rows,
        "recomputed": recomputed,
    }


def authority_lines(
    terms: ProductTerms,
    *,
    amount: Decimal,
    term_months: int,
    rate: Decimal,
    limit: Decimal | None,
    min_rate: Decimal | None,
    comment: str | None,
) -> list[str]:
    """Проверка решения аналитика по границам полномочий (docs/credit-policy.md, «Полномочия аналитика»)."""
    lines = []
    if limit is None:
        lines.append("Расчётный лимит не определён")
    elif amount > limit:
        over = (amount - limit) / limit * 100
        lines.append(
            f"Расчётный лимит {rub(limit)}, сумма выше лимита на {pp(Decimal(round(over, 1)))} % — с обоснованием"
        )
    else:
        lines.append(f"Расчётный лимит {rub(limit)}, сумма в пределах лимита")
    lines.append(
        f"Минимальная ставка по классу риска {percent(min_rate)}, в решении {percent(rate)}"
        if min_rate is not None
        else f"Ставка в решении {percent(rate)}"
    )
    lines.append(
        f"Сумма от {rub(terms.min_amount)} до {rub(terms.max_amount)}, "
        f"срок от {terms.min_term} до {terms.max_term} мес. по продукту"
    )
    errors = check_analyst_terms(
        terms, amount=amount, term_months=term_months, rate=rate, limit=limit, min_rate=min_rate, comment=comment
    )
    lines.append("Нарушений полномочий нет" if not errors else "Нарушения: " + "; ".join(errors))
    return lines


# ---------------------------------------------------------------- сборка содержимого из моделей


def collect(db: Session, application: Application, user: User) -> dict[str, Any]:
    """Содержимое обоснования из сохранённых данных заявки — простые словари и строки для ``render``."""
    company = application.company
    steps = run_results(db, application)
    scoring = latest_scoring(db, application)
    decisions = db.scalars(
        select(Decision).where(Decision.application_id == application.id).order_by(Decision.id)
    ).all()
    auto = next((d for d in reversed(decisions) if d.kind == DecisionKind.AUTO), None)
    manual = [d for d in decisions if d.kind == DecisionKind.MANUAL]
    offers = db.scalars(
        select(Offer).where(Offer.application_id == application.id).order_by(Offer.created_at, Offer.option_no)
    ).all()
    requests = db.scalars(
        select(InfoRequest).where(InfoRequest.application_id == application.id).order_by(InfoRequest.created_at)
    ).all()
    documents = db.scalars(
        select(Document).where(Document.application_id == application.id).order_by(Document.created_at)
    ).all()
    signatures = db.scalars(
        select(Signature).where(Signature.application_id == application.id).order_by(Signature.created_at)
    ).all()
    history = db.scalars(
        select(StatusHistory).where(StatusHistory.application_id == application.id).order_by(StatusHistory.id)
    ).all()
    loan = db.scalars(select(Loan).where(Loan.application_id == application.id)).first()
    users = {u.id: u.full_name for u in db.scalars(select(User))}
    name = users.get

    policy_version = auto.policy_version if auto else POLICY_VERSION
    scoring_version = scoring.scoring_version if scoring else SCORING_VERSION
    header: Facts = [
        ["Компания", f"{company.name}, ИНН {company.inn}, {legal_form(company.legal_form)}"],
        ["Продукт", f"{application.product.name} ({application.product_code})"],
        ["Сумма и срок", f"{rub(application.amount)} на {months_text(application.term_months)}"],
        [
            "Цель",
            PURPOSE_LABELS.get(application.purpose, application.purpose)
            + (f": {application.purpose_text}" if application.purpose_text else ""),
        ],
    ]
    if application.declared_revenue:
        header.append(["Заявленная выручка", f"{rub(application.declared_revenue)} в год"])
    if application.collateral_value:
        header.append(["Залог", f"{application.collateral_type or 'Имущество'}, {rub(application.collateral_value)}"])
    header += [
        ["Дата подачи", when(application.submitted_at)],
        ["Текущий статус", f"{STATUS_LABELS[application.status]['bank']}, с {when(application.status_changed_at)}"],
        ["Исполнитель", application.assignee.full_name if application.assignee else "не назначен"],
        ["Прогон автоматической проверки", f"№ {application.run_no}"],
        ["Версии правил", f"кредитная политика {policy_version}, скоринговая карта {scoring_version}"],
    ]

    sources = []
    for code in SOURCE_STEPS:
        row = steps.get(code)
        if row is None:
            sources.append(source_section(code, StepStatus.PENDING, None, None, 0, None))
            continue
        sources.append(source_section(code, row.status, row.result, row.error, row.attempts, row.finished_at))
    statement = latest_statement(db, application)
    if statement:
        sources.append(
            {
                "title": "Выписка по счёту, загруженная клиентом",
                "meta": "разобрана при загрузке",
                "facts": statement_facts(statement),
                "table": None,
                "note": None,
            }
        )
    uploaded = [d for d in documents if d.kind not in ("AGREEMENT", "SCHEDULE")]
    client_documents = [
        [DOCUMENT_LABELS.get(d.kind, d.kind), f"{d.file_name}, {when(d.created_at)}, SHA-256 {d.sha256[:16]}…"]
        for d in uploaded
    ]

    scoring_block = None
    if scoring is not None:
        scoring_block = scoring_content(
            version=scoring.scoring_version,
            score=scoring.score,
            risk_class=scoring.risk_class,
            pd=scoring.pd,
            factors=scoring.factors,
            features=scoring.features,
        )

    policy = None
    if auto is not None or scoring is not None:
        terms = ProductTerms.from_model(application.product)
        margin = margin_for_class(scoring.risk_class) if scoring else None
        limit = None
        if scoring is not None and margin is not None:
            limit = limit_content(
                terms,
                Features.from_dict(scoring.features),
                rate=Decimal(auto.rate) if auto and auto.rate is not None else terms.base_rate + margin,
                term_months=application.term_months,
                collateral_value=Decimal(application.collateral_value) if application.collateral_value else None,
                decided_limit=Decimal(auto.limit_amount) if auto and auto.limit_amount is not None else None,
            )
        policy = {
            "version": policy_version,
            "stop_factors": [
                f"{code} — {STOP_FACTORS.get(code, code)}" for code in (auto.stop_factors if auto else [])
            ],
            "flags": [f"{code} — {FLAGS.get(code, code)}" for code in (auto.flags if auto else [])],
            "limit": limit,
            "trace": [
                [row.get("rule", ""), row.get("result", ""), row.get("detail") or "—"]
                for row in (auto.trace if auto else [])
            ],
            "outcome": OUTCOME_LABELS.get(auto.outcome, auto.outcome) if auto else None,
            "decided_at": when(auto.created_at) if auto else None,
            "reasons": [
                f"{code} — {REASONS[code][0]}" for code in (auto.reason_codes if auto else []) if code in REASONS
            ],
            "rate": f"{percent(auto.rate)} годовых" if auto and auto.rate is not None else None,
        }

    offers_by_decision: dict[int, Offer] = {}
    for offer in offers:
        offers_by_decision.setdefault(offer.decision_id, offer)
    human_decisions = []
    for d in manual:
        offer = offers_by_decision.get(d.id)
        entry: dict[str, Any] = {
            "who": name(d.decided_by) or "сотрудник банка",
            "when": when(d.created_at),
            "outcome": OUTCOME_LABELS.get(d.outcome, d.outcome),
            "terms": None,
            "comment": d.comment,
            "authority": [],
        }
        if d.outcome == Outcome.REJECT:
            entry["terms"] = (
                "; ".join(f"{code} — {REASONS[code][0]}" for code in d.reason_codes if code in REASONS) or None
            )
        elif offer is not None:
            kind = "как запрошено" if offer.kind == "AS_REQUESTED" else "контрпредложение"
            entry["terms"] = (
                f"{offer.product.name}: {rub(offer.amount)} на {months_text(offer.term_months)} "
                f"под {percent(offer.rate)} годовых, платёж {rub(offer.monthly_payment)} ({kind})"
            )
            offer_terms = ProductTerms.from_model(offer.product)
            margin = margin_for_class(scoring.risk_class) if scoring else None
            entry["authority"] = authority_lines(
                offer_terms,
                amount=Decimal(offer.amount),
                term_months=offer.term_months,
                rate=Decimal(offer.rate),
                limit=Decimal(d.limit_amount) if d.limit_amount is not None else None,
                min_rate=offer_terms.base_rate + margin if margin is not None else None,
                comment=d.comment,
            )
        human_decisions.append(entry)

    attached: dict[Any, list[str]] = {}
    for d in documents:
        if d.info_request_id is not None:
            attached.setdefault(d.info_request_id, []).append(f"{d.file_name} ({DOCUMENT_LABELS.get(d.kind, d.kind)})")
    info_requests = [
        {
            "who": "система (конвейер)" if r.origin == "SYSTEM" else (name(r.requested_by) or "аналитик"),
            "when": when(r.created_at),
            "items": [item.get("title", item.get("code", "")) for item in r.items],
            "comment": r.comment,
            "due": when(r.due_at),
            "status": INFO_STATUS.get(r.status, r.status),
            "answer": r.answer_text,
            "answered_at": when(r.answered_at) if r.answered_at else None,
            "documents": attached.get(r.id, []),
        }
        for r in requests
    ]

    history_rows = [
        [
            when(h.created_at),
            STATUS_LABELS[h.to_status]["bank"],
            ACTOR_LABELS.get(h.actor, h.actor)
            + (f": {name(h.actor_user_id)}" if h.actor_user_id and name(h.actor_user_id) else ""),
            h.reason or "—",
        ]
        for h in history
    ]

    offer_rows = []
    for offer in offers:
        status = OFFER_STATUS.get(offer.status, offer.status)
        if offer.accepted_at:
            status += f", {when(offer.accepted_at)}"
        note = offer.note or ("контрпредложение" if offer.kind == "COUNTER" else "как запрошено")
        variant = f"{offer.product.name} — {note}, действует до {day(offer.valid_until)}"
        offer_rows.append(
            [
                variant,
                rub(offer.amount),
                months_text(offer.term_months),
                percent(offer.rate),
                rub(offer.monthly_payment),
                status,
            ]
        )

    agreement = next((d for d in reversed(documents) if d.kind == "AGREEMENT"), None)
    signature_rows = [
        [
            "Клиент" if s.signer_role == "CLIENT" else "Банк",
            name(s.signer_user_id) or ("—" if s.signer_role == "BANK" else "клиент"),
            SIGN_METHODS.get(s.method, s.method),
            when(s.created_at),
        ]
        for s in signatures
    ]
    agreement_block = None
    if agreement is not None:
        agreement_block = {
            "file": agreement.file_name,
            "sha256": agreement.sha256,
            "created_at": when(agreement.created_at),
        }
    loan_block = None
    if loan is not None:
        loan_block = [
            ["Ссудный счёт", loan.account_number],
            ["Сумма", rub(loan.amount)],
            ["Ставка", f"{percent(loan.rate)} годовых"],
            ["Срок", months_text(loan.term_months)],
            ["Ежемесячный платёж", rub(loan.monthly_payment)],
            ["Дата выдачи", when(loan.issued_at)],
        ]

    return {
        "number": application.number,
        "generated_at": when(datetime.now(UTC)),
        "generated_by": f"{user.full_name}, {ROLE_LABELS.get(user.role, user.role)}",
        "header": header,
        "sources": sources,
        "client_documents": client_documents,
        "scoring": scoring_block,
        "policy": policy,
        "decisions": human_decisions,
        "info_requests": info_requests,
        "history": history_rows,
        "offers": offer_rows,
        "signatures": signature_rows,
        "agreement": agreement_block,
        "loan": loan_block,
    }


# ---------------------------------------------------------------- отрисовка PDF


def _cell_styles() -> dict[str, ParagraphStyle]:
    regular, bold = _fonts()
    cell = ParagraphStyle("cell", fontName=regular, fontSize=8.5, leading=11)
    return {
        "cell": cell,
        "cell_bold": ParagraphStyle("cell_bold", parent=cell, fontName=bold),
        "cell_bold_right": ParagraphStyle("cell_bold_right", parent=cell, fontName=bold, alignment=TA_RIGHT),
        "cell_muted": ParagraphStyle("cell_muted", parent=cell, textColor=colors.HexColor("#6F7079")),
        "h2": ParagraphStyle("h2", fontName=bold, fontSize=9.5, leading=13, spaceBefore=6, spaceAfter=3),
    }


def _text(value: Any) -> str:
    return escape(str(value if value is not None else "—")).replace("\n", "<br/>")


def _p(value: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(_text(value), style)


def _data_table(
    header: list[str],
    rows: list[list[Any]],
    widths_mm: list[float],
    s: dict[str, ParagraphStyle],
    *,
    numeric: tuple[int, ...] = (),
    muted: tuple[int, ...] = (),
    bold: tuple[int, ...] = (),
    highlight: tuple[int, ...] = (),
) -> Table:
    """Таблица в стиле договора: текст в ячейках переносится, числовые колонки прижаты вправо.

    ``highlight`` — номера строк данных (с 1), которые нужно выделить фоном.
    """
    head = [_p(label, s["cell_bold_right"] if i in numeric else s["cell_bold"]) for i, label in enumerate(header)]
    body = []
    for row in rows:
        cells = []
        for i, value in enumerate(row):
            if i in numeric:
                cells.append(str(value))
            else:
                style = s["cell_muted"] if i in muted else s["cell_bold"] if i in bold else s["cell"]
                cells.append(_p(value, style))
        body.append(cells)
    table = _table([head] + body, [w * mm for w in widths_mm], header=True)
    extra: list[tuple] = [("ALIGN", (col, 1), (col, -1), "RIGHT") for col in numeric]
    extra += [("BACKGROUND", (0, row), (-1, row), colors.HexColor("#EEF4FF")) for row in highlight]
    if extra:
        table.setStyle(TableStyle(extra))
    return table


def _facts(facts: Facts, s: dict[str, ParagraphStyle]) -> Table:
    rows = [[_p(label, s["cell_muted"]), _p(value, s["cell"])] for label, value in facts]
    return _table(rows, [52 * mm, 122 * mm], header=False)


def _source_table(spec: dict[str, Any], s: dict[str, ParagraphStyle]) -> Table:
    return _data_table(spec["header"], spec["rows"], spec["widths"], s, numeric=tuple(spec.get("numeric", ())))


def _bullets(items: list[str], style: ParagraphStyle) -> list[Paragraph]:
    return [Paragraph(f"• {_text(item)}", style) for item in items]


def _section(title: str, first: Any, s: dict[str, ParagraphStyle]) -> KeepTogether:
    """Заголовок раздела вместе с первым блоком, чтобы он не остался один внизу страницы."""
    body = first if isinstance(first, list) else [first]
    return KeepTogether([Paragraph(title, s["h"]), *body])


def _sources_story(content: dict[str, Any], s: dict[str, ParagraphStyle]) -> list[Any]:
    story: list[Any] = []
    for source in content["sources"]:
        title = f"{_text(source['title'])} <font color='#6F7079'>— {_text(source['meta'])}</font>"
        block: list[Any] = [Paragraph(title, s["h2"])]
        if source.get("note"):
            block.append(Paragraph(_text(source["note"]), s["note"]))
        if source.get("facts"):
            block.append(_facts(source["facts"], s))
        tail: list[Any] = [Spacer(1, 2 * mm), _source_table(source["table"], s)] if source.get("table") else []
        if len(block) == 1 and tail:
            # фактов нет — таблицу держим вместе с заголовком, иначе он останется один внизу страницы
            block, tail = block + tail, []
        if len(block) == 1:
            block.append(Paragraph("Данных нет.", s["note"]))
        story.append(KeepTogether(block))
        story.extend(tail)
    if content.get("client_documents"):
        story.append(
            KeepTogether(
                [Paragraph("Документы, загруженные по заявке", s["h2"]), _facts(content["client_documents"], s)]
            )
        )
    return story


def _scoring_story(scoring: dict[str, Any] | None, s: dict[str, ParagraphStyle]) -> list[Any]:
    if scoring is None:
        return [
            _section(
                "3. Скоринг", Paragraph("Оценка риска ещё не выполнена: конвейер не дошёл до шага скоринга.", s["p"]), s
            )
        ]
    factors = _data_table(
        ["Фактор", "Значение", "Баллы", "Пояснение"], scoring["factors"], [46, 46, 16, 66], s, numeric=(2,), muted=(3,)
    )
    summary: Facts = [
        ["Итоговый балл", f"{scoring['score']} ({scoring['total']})"],
        ["Класс риска", f"{scoring['risk_class']}, условная вероятность дефолта {scoring['pd']}"],
        ["Надбавка к ставке", scoring["margin"]],
        ["Версия скоринговой карты", scoring["version"]],
    ]
    story: list[Any] = [_section("3. Скоринг", factors, s), Spacer(1, 2 * mm), _facts(summary, s)]
    if scoring.get("features"):
        story.append(
            KeepTogether(
                [Paragraph("Ключевые признаки, использованные в расчёте", s["h2"]), _facts(scoring["features"], s)]
            )
        )
    return story


def _policy_story(policy: dict[str, Any] | None, s: dict[str, ParagraphStyle]) -> list[Any]:
    if policy is None:
        return [_section("4. Кредитная политика", Paragraph("Автоматическое решение ещё не принято.", s["p"]), s)]
    facts: Facts = [
        ["Стоп-факторы", "; ".join(policy["stop_factors"]) or "нет"],
        ["Флаги ручного рассмотрения", "; ".join(policy["flags"]) or "нет"],
    ]
    if policy.get("reasons"):
        facts.append(["Причины отказа", "; ".join(policy["reasons"])])
    story: list[Any] = [_section("4. Кредитная политика", _facts(facts, s), s)]
    limit = policy.get("limit")
    if limit is not None:
        title = f"Расчёт лимита: {_text(limit['amount'])}"
        if limit.get("phrase"):
            title += f" — {_text(limit['phrase'])}"
        title += f". Расчётная ставка {_text(limit['rate'])}"
        rows = []
        highlight = []
        for index, (label, amount, note, binding) in enumerate(limit["constraints"], start=1):
            rows.append([label, amount, note + (" — определяет лимит" if binding else "")])
            if binding:
                highlight.append(index)
        table = _data_table(
            ["Ограничение", "Сумма", "Пояснение"],
            rows,
            [60, 34, 80],
            s,
            numeric=(1,),
            muted=(2,),
            highlight=tuple(highlight),
        )
        story.append(KeepTogether([Paragraph(title, s["h2"]), table]))
        if limit.get("recomputed"):
            story.append(Paragraph(_text(limit["recomputed"]), s["note"]))
    if policy.get("trace"):
        table = _data_table(
            ["Правило", "Результат", "Подробности"], policy["trace"], [48, 40, 86], s, bold=(1,), muted=(2,)
        )
        story.append(
            KeepTogether([Paragraph(f"Правила решения, кредитная политика {_text(policy['version'])}", s["h2"]), table])
        )
    if policy.get("outcome"):
        line = f"Исход автоматического решения: {_text(policy['outcome'])}, {_text(policy['decided_at'])}"
        if policy.get("rate"):
            line += f", ставка {_text(policy['rate'])}"
        story += [Spacer(1, 2 * mm), Paragraph(line, s["p"])]
    return story


def _people_story(content: dict[str, Any], s: dict[str, ParagraphStyle]) -> list[Any]:
    decisions = content.get("decisions") or []
    blocks: list[list[Any]] = []
    for entry in decisions:
        block: list[Any] = [
            Paragraph(f"{_text(entry['outcome'])} — {_text(entry['who'])}, {_text(entry['when'])}", s["h2"])
        ]
        if entry.get("terms"):
            block.append(Paragraph(f"Условия: {_text(entry['terms'])}", s["p"]))
        if entry.get("comment"):
            block.append(Paragraph(f"Комментарий: {_text(entry['comment'])}", s["p"]))
        if entry.get("authority"):
            block.append(Paragraph("Проверка полномочий:", s["p"]))
            block.extend(_bullets(entry["authority"], s["p"]))
        blocks.append(block)
    if not blocks:
        blocks.append([Paragraph("Решений сотрудников банка по заявке нет.", s["p"])])
    story: list[Any] = [_section("5. Решения людей", blocks[0], s)]
    story += [KeepTogether(block) for block in blocks[1:]]
    requests = content.get("info_requests") or []
    for index, r in enumerate(requests):
        block = []
        if index == 0:
            block.append(Paragraph("Запросы информации и ответы клиента", s["h2"]))
        block.append(
            Paragraph(
                f"Запрос от {_text(r['who'])}, {_text(r['when'])}, срок ответа до {_text(r['due'])} — "
                f"{_text(r['status'])}",
                s["p"],
            )
        )
        block.extend(_bullets(r["items"], s["p"]))
        if r.get("comment"):
            block.append(Paragraph(f"Комментарий банка: {_text(r['comment'])}", s["note"]))
        if r.get("answer") or r.get("documents"):
            answer = _text(r["answer"]) if r.get("answer") else "без текста"
            answered = f", {_text(r['answered_at'])}" if r.get("answered_at") else ""
            docs = f" Приложено: {_text(', '.join(r['documents']))}." if r.get("documents") else ""
            block.append(Paragraph(f"Ответ клиента{answered}: {answer}.{docs}", s["p"]))
        block.append(Spacer(1, 1.5 * mm))
        story.append(KeepTogether(block))
    if content.get("history"):
        table = _data_table(["Когда", "Статус", "Кто", "Причина"], content["history"], [34, 34, 42, 64], s, muted=(3,))
        story.append(KeepTogether([Paragraph("Ход рассмотрения", s["h2"]), table]))
    return story


def _offers_story(content: dict[str, Any], s: dict[str, ParagraphStyle]) -> list[Any]:
    offers = content.get("offers") or []
    if offers:
        first: Any = _data_table(
            ["Вариант", "Сумма", "Срок", "Ставка", "Платёж", "Статус"],
            offers,
            [48, 26, 22, 18, 26, 34],
            s,
            numeric=(1, 3, 4),
        )
    else:
        first = Paragraph("Предложений клиенту не было.", s["p"])
    story: list[Any] = [_section("6. Предложения клиенту, подписание и выдача", first, s)]
    agreement = content.get("agreement")
    if agreement:
        signatures = content.get("signatures") or []
        if signatures:
            block: Any = _data_table(["Сторона", "Кто", "Способ", "Когда"], signatures, [22, 54, 62, 36], s)
        else:
            block = Paragraph("Договор сформирован, подписей ещё нет.", s["p"])
        story.append(KeepTogether([Paragraph("Подписание", s["h2"]), block]))
        story.append(
            Paragraph(
                f"Договор: {_text(agreement['file'])}, сформирован {_text(agreement['created_at'])}. "
                f"Отпечаток SHA-256: {_text(agreement['sha256'])}",
                s["note"],
            )
        )
    loan = content.get("loan")
    if loan:
        story.append(KeepTogether([Paragraph("Выдача", s["h2"]), _facts(loan, s)]))
    elif not agreement:
        story.append(Paragraph("Договор не формировался, кредит не выдавался.", s["note"]))
    return story


def render(content: dict[str, Any]) -> bytes:
    """PDF обоснования по содержимому из ``collect``. Все значения — уже отформатированные строки."""
    s = _styles()
    s.update(_cell_styles())
    regular, _ = _fonts()
    number = content["number"]
    stamp = f"Сформировано {content['generated_at']} (МСК), пользователь {content['generated_by']}"

    def footer(canvas, doc) -> None:
        canvas.saveState()
        canvas.setFont(regular, 7.5)
        canvas.setFillColor(colors.HexColor("#6F7079"))
        canvas.drawString(doc.leftMargin, 12 * mm, stamp)
        canvas.drawString(doc.leftMargin, 8 * mm, f"Обоснование решения по заявке № {number}")
        canvas.drawRightString(A4[0] - doc.rightMargin, 8 * mm, f"Страница {doc.page}")
        canvas.restoreState()

    story: list[Any] = [
        Paragraph(f"Обоснование решения по заявке № {number}", s["title"]),
        Paragraph(
            f"{_text(stamp)}. Документ для внутреннего аудита: входные данные источников, расчёт скоринга, "
            "правила кредитной политики и решения сотрудников по сохранённым данным конвейера. "
            "Формирование обоснования записано в журнал действий по заявке.",
            s["subtitle"],
        ),
        Spacer(1, 4 * mm),
        _section("1. Заявка", _facts(content["header"], s), s),
        Paragraph("2. Входные данные по источникам", s["h"]),
    ]
    story += _sources_story(content, s)
    story += _scoring_story(content.get("scoring"), s)
    story += _policy_story(content.get("policy"), s)
    story += _people_story(content, s)
    story += _offers_story(content, s)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=18 * mm,
        title=f"Обоснование решения по заявке № {number}",
    )
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()


def file_name(application: Application) -> str:
    return f"Обоснование решения {application.number}.pdf"


def justification_pdf(db: Session, application: Application, user: User) -> tuple[bytes, str]:
    """PDF обоснования и имя файла для скачивания."""
    return render(collect(db, application, user)), file_name(application)
