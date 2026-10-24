"""Обоснование решения для аудита: сборка PDF из простых словарей и разбор сохранённых ответов источников."""

from decimal import Decimal

from app.domain.catalog import PRODUCTS
from app.domain.features import Features
from app.services import justification as j
from tests.unit.factories import strong_company

P = {p.code: p for p in PRODUCTS}

EGRUL = {
    "found": True,
    "name": "ООО «Вектор Логистик»",
    "legal_form": "OOO",
    "ogrn": "1007700000032",
    "registration_date": "2023-06-22",
    "status": "ACTIVE",
    "okved": "49.41",
    "okved_name": "Деятельность автомобильного грузового транспорта",
    "address": "г. Москва, Деловой бульвар, д. 1, офис 315",
    "director": {"name": "Громов Артём Валерьевич", "since": "2023-06-22"},
}
BKI = {
    "has_history": True,
    "max_overdue_days_24m": 12,
    "current_overdue_days": 0,
    "loans": [
        {
            "lender": "Банк «Восток»",
            "kind": "Кредит",
            "amount": 9_000_000,
            "balance": 5_200_000,
            "monthly_payment": 250_000,
            "opened_at": "2024-12-22",
        }
    ],
}
BANK = {
    "is_client": True,
    "account_opened_at": "2025-04-22",
    "months": [{"month": f"2026-{m:02d}", "inflow": 3_000_000.0 if m != 3 else 0} for m in range(1, 13)],
}
FACTORS = [
    {
        "code": "BUSINESS_AGE",
        "title": "Срок ведения бизнеса",
        "value": "3 года 4 мес.",
        "points": 30,
        "phrase": "Бизнес работает больше 3 лет",
    },
    {
        "code": "TAX_DEBT",
        "title": "Налоговая задолженность",
        "value": "82\u00a0000\u00a0₽",
        "points": -30,
        "phrase": "Есть налоговая задолженность",
    },
    {"code": "INDUSTRY", "title": "Отраслевой риск", "value": "средний (ОКВЭД 49.41)", "points": 0, "phrase": None},
]


def content(**overrides) -> dict:
    """Содержимое обоснования, как его собирает collect, но без базы: простые словари и строки."""
    features = strong_company(amount=Decimal("6000000"), term_months=36)
    limit = j.limit_content(
        P["GROWTH"], features, rate=Decimal("20.5"), term_months=36, collateral_value=None, decided_limit=None
    )
    base = {
        "number": "2026-00001",
        "generated_at": "24.10.2026 12:00",
        "generated_by": "Иванова Ольга Дмитриевна, кредитный аналитик",
        "header": [["Компания", "ООО «Вектор Логистик», ИНН 0010000031"], ["Продукт", "Кредит на развитие бизнеса"]],
        "sources": [
            j.source_section("EGRUL", "DONE", EGRUL, None, 1, None),
            j.source_section(
                "GIRBO", "SKIPPED", {"available": False, "reason": "Отчётность не сдавалась"}, None, 1, None
            ),
            j.source_section("BKI", "DONE", BKI, None, 2, None),
            j.source_section("BANK", "DONE", BANK, None, 1, None),
        ],
        "client_documents": [],
        "scoring": j.scoring_content(
            version="v1.0", score=720, risk_class="B", pd=Decimal("3"), factors=FACTORS, features=features.to_dict()
        ),
        "policy": {
            "version": "v1.0",
            "stop_factors": [],
            "flags": ["F01 — Адрес массовой регистрации", "F02 — Есть налоговая задолженность"],
            "limit": limit,
            "trace": [["Стоп-факторы", "нет", "—"], ["Флаги ручного рассмотрения", "есть", "F01, F02"]],
            "outcome": "Передано аналитику",
            "decided_at": "24.10.2026 11:00",
            "reasons": [],
            "rate": "20,5\u00a0% годовых",
        },
        "decisions": [
            {
                "who": "Иванова Ольга Дмитриевна",
                "when": "24.10.2026 11:40",
                "outcome": "Контрпредложение",
                "terms": (
                    "Кредит на развитие бизнеса: 6\u00a0000\u00a0000\u00a0₽ на 3 года под 20,5\u00a0% годовых "
                    "(контрпредложение)"
                ),
                "comment": "Стабильные поступления на счёт & задолженность погашается <до конца месяца>",
                "authority": j.authority_lines(
                    P["GROWTH"],
                    amount=Decimal("6000000"),
                    term_months=36,
                    rate=Decimal("20.5"),
                    limit=Decimal("5650000"),
                    min_rate=Decimal("20.5"),
                    comment="обоснование",
                ),
            }
        ],
        "info_requests": [
            {
                "who": "Иванова Ольга Дмитриевна",
                "when": "24.10.2026 11:10",
                "items": ["Пояснение по налоговой задолженности"],
                "comment": "Поясните задолженность",
                "due": "26.10.2026 11:10",
                "status": "Ответ получен",
                "answer": "Погасим до конца месяца",
                "answered_at": "24.10.2026 11:30",
                "documents": ["platezhka.pdf (Другой документ)"],
            }
        ],
        "history": [["24.10.2026 11:00", "Ручное рассмотрение", "Система", "F01, F02"]],
        "offers": [
            [
                "Кредит на развитие бизнеса — контрпредложение",
                "6\u00a0000\u00a0000\u00a0₽",
                "3 года",
                "20,5\u00a0%",
                "230\u00a0000\u00a0₽",
                "Действует",
            ]
        ],
        "signatures": [],
        "agreement": None,
        "loan": None,
    }
    base.update(overrides)
    return base


def test_pdf_is_built_from_plain_content():
    pdf = j.render(content())
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 2048
    # несколько страниц: у каждой свой объект Page
    assert pdf.count(b"/Type /Page\n") + pdf.count(b"/Type /Page ") >= 2


def test_pdf_is_built_for_application_without_scoring_and_decisions():
    waiting = j.source_section("BKI", "WAITING", None, "bki: сервис ответил ошибкой 503", 3, None)
    pending = j.source_section("BANK", "PENDING", None, None, 0, None)
    pdf = j.render(
        content(
            sources=[waiting, pending], scoring=None, policy=None, decisions=[], info_requests=[], history=[], offers=[]
        )
    )
    assert pdf.startswith(b"%PDF") and len(pdf) > 2048
    assert "Повторяем автоматически" in waiting["note"]
    assert pending["note"] == "Запрос ещё не выполнялся."


def test_signing_and_loan_sections_are_rendered():
    pdf = j.render(
        content(
            signatures=[["Клиент", "Лебедева Марина Олеговна", "Простая электронная подпись", "24.10.2026 12:30"]],
            agreement={
                "file": "Кредитный договор 2026-00001.pdf",
                "sha256": "a" * 64,
                "created_at": "24.10.2026 12:20",
            },
            loan=[["Ссудный счёт", "45207810000000000001"], ["Сумма", "6\u00a0000\u00a0000\u00a0₽"]],
        )
    )
    assert pdf.startswith(b"%PDF") and len(pdf) > 2048


def test_source_facts_from_saved_results():
    checks = {"checks": [{"title": "ИНН корректен", "ok": True}, {"title": "Указан залог", "ok": False}]}
    assert j.data_check_facts(checks) == [["Не пройдены", "Указан залог"], ["Пройдены", "1 из 2: ИНН корректен"]]
    assert j.data_check_facts({"checks": [{"title": "ИНН корректен", "ok": True}]}) == [
        ["Пройдены", "1 из 1: ИНН корректен"]
    ]

    egrul = j.egrul_facts(EGRUL)
    assert ["Статус", "Действующая"] in egrul
    assert ["Руководитель", "Громов Артём Валерьевич, с 22.06.2023"] in egrul
    assert j.egrul_facts({"found": False}) == [["Результат", "Компания не найдена в реестре"]]

    fns = j.fns_facts({"tax_debt": 82000, "mass_address": True, "director_disqualified": False})
    assert fns[:2] == [["Налоговая задолженность", "82\u00a0000\u00a0₽"], ["Адрес массовой регистрации", "да"]]

    facts, table = j.bki_block(BKI)
    assert ["Максимальная просрочка за 24 мес.", "12 дн."] in facts
    assert table["rows"][0][0] == "Банк «Восток»" and table["rows"][0][-1] == "22.12.2024"

    facts, table = j.bank_block(BANK)
    assert ["Месяцев с поступлениями", "11 из 12"] in facts
    assert len(table["rows"]) == 6 and table["header"] == ["Месяц", "Поступления", "Месяц", "Поступления"]

    facts, table = j.girbo_block({"available": False, "reason": "ИП не сдаёт отчётность"})
    assert facts == [["Результат", "ИП не сдаёт отчётность"]] and table is None
    _, table = j.girbo_block(
        {"available": True, "years": [{"year": 2025, "revenue": 1000, "sales_profit": 200, "net_profit": 100}]}
    )
    assert table["rows"] == [["2025", "1\u00a0000\u00a0₽", "200\u00a0₽", "100\u00a0₽", "20\u00a0%"]]


def test_scoring_summary_and_limit_constraints():
    features = strong_company(amount=Decimal("3000000"), term_months=24)
    scoring = j.scoring_content(
        version="v1.0", score=830, risk_class="A", pd=Decimal("1"), factors=FACTORS, features=features.to_dict()
    )
    assert scoring["margin"] == "+0\u00a0п.п. к базовой ставке продукта"
    assert scoring["total"] == "базовый балл 600 + 0 по факторам = 830"
    assert scoring["factors"][1][2] == "-30"
    assert ["Выручка за год", "120\u00a0000\u00a0000\u00a0₽ по отчётности ГИР БО"] in scoring["features"]
    assert (
        j.scoring_content(version="v1.0", score=400, risk_class="E", pd=Decimal("25"), factors=[], features={})[
            "margin"
        ]
        == "ставка не назначается"
    )

    limit = j.limit_content(
        P["GROWTH"],
        features,
        rate=Decimal("19"),
        term_months=24,
        collateral_value=None,
        decided_limit=Decimal("9230000"),
    )
    assert limit["amount"] == "9\u00a0230\u00a0000\u00a0₽"
    assert limit["phrase"] == "Текущие платежи по кредитам и прибыль ограничивают сумму"
    binding = [row for row in limit["constraints"] if row[3]]
    assert len(binding) == 1 and binding[0][0] == "По платёжеспособности (DSCR ≥ 1,3)"
    assert limit["recomputed"] is None
    stale = j.limit_content(
        P["GROWTH"],
        features,
        rate=Decimal("19"),
        term_months=24,
        collateral_value=None,
        decided_limit=Decimal("1000000"),
    )
    assert stale["recomputed"] == "Пересчёт по текущей версии политики даёт 9\u00a0230\u00a0000\u00a0₽"


def test_authority_check_explains_limits_and_violations():
    ok = j.authority_lines(
        P["GROWTH"],
        amount=Decimal("6000000"),
        term_months=36,
        rate=Decimal("20.5"),
        limit=Decimal("5650000"),
        min_rate=Decimal("20.5"),
        comment="Стабильные поступления",
    )
    assert ok[0] == "Расчётный лимит 5\u00a0650\u00a0000\u00a0₽, сумма выше лимита на 6,2\u00a0% — с обоснованием"
    assert ok[1] == "Минимальная ставка по классу риска 20,5\u00a0%, в решении 20,5\u00a0%"
    assert ok[-1] == "Нарушений полномочий нет"

    bad = j.authority_lines(
        P["GROWTH"],
        amount=Decimal("8000000"),
        term_months=36,
        rate=Decimal("18"),
        limit=Decimal("5650000"),
        min_rate=Decimal("20.5"),
        comment=None,
    )
    assert bad[-1].startswith("Нарушения: Ставка не может быть ниже расчётной")
    assert "больше чем на 20\u00a0%" in bad[-1]

    no_limit = j.authority_lines(
        P["GROWTH"],
        amount=Decimal("1000000"),
        term_months=12,
        rate=Decimal("19"),
        limit=None,
        min_rate=None,
        comment=None,
    )
    assert no_limit[0] == "Расчётный лимит не определён" and no_limit[1] == "Ставка в решении 19\u00a0%"


def test_formatting_helpers():
    assert j.percent(Decimal("20.50")) == "20,5\u00a0%"
    assert j.percent(None) == "—"
    assert j.day("2026-10-24T11:00:00Z") == "24.10.2026"
    assert j.day(None) == "—"
    assert j.legal_form("IP") == "Индивидуальный предприниматель"
    assert j.signed(30) == "+30" and j.signed(-30) == "-30" and j.signed(0) == "0"
    assert (
        j.scoring_content(version="v1.0", score=600, risk_class="C", pd=6, factors=[], features=Features().to_dict())[
            "features"
        ]
        == []
    )
