"""Конструктор персон: созданная компания видна во всех источниках, данные детерминированы и переживают перезапуск."""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from sim.companies import INFLOW_PATTERN, CompanySpec, CompanyStore, build_persona, half_up, make_inn, make_ogrn
from sim.main import app

client = TestClient(app)

# Встроенные персоны: с их ИНН и ОГРН созданные компании совпадать не должны
BUILTIN = json.loads((Path(__file__).parents[1] / "sim" / "data" / "companies.json").read_text(encoding="utf-8"))[
    "companies"
]
BUILTIN_OGRNS = {persona["egrul"]["ogrn"] for persona in BUILTIN.values()}

STABLE = {
    "name": "Полярная звезда",
    "legal_form": "OOO",
    "registered_months_ago": 74,
    "okved": "46.39",
    "okved_name": "Торговля оптовая неспециализированная пищевыми продуктами",
    "revenue": 60_000_000,
    "revenue_growth": 0.12,
    "margin": 0.1,
    "existing_monthly_payments": 150_000,
    "max_overdue_days_24m": 0,
    "current_overdue_days": 0,
    "tax_debt": 0,
    "mass_address": False,
    "director_disqualified": False,
    "company_status": "ACTIVE",
    "is_bank_client": True,
    "account_months": 60,
    "avg_monthly_inflow": 5_000_000,
}


def _checksum(digits: list[int], weights: list[int]) -> int:
    return sum(d * w for d, w in zip(digits, weights, strict=False)) % 11 % 10


def is_valid_inn(inn: str) -> bool:
    """Та же проверка, что в backend/app/services/inn.py: шаг «Проверка данных заявки» её не пропустит."""
    if not inn.isdigit() or len(inn) not in (10, 12):
        return False
    d = [int(c) for c in inn]
    if len(inn) == 10:
        return d[9] == _checksum(d, [2, 4, 10, 3, 5, 9, 4, 6, 8])
    n11 = _checksum(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
    n12 = _checksum(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
    return d[10] == n11 and d[11] == n12


def is_valid_ogrn(ogrn: str) -> bool:
    if len(ogrn) == 13:
        return int(ogrn[:12]) % 11 % 10 == int(ogrn[12])
    return len(ogrn) == 15 and int(ogrn[:14]) % 13 % 10 == int(ogrn[14])


def test_generated_identifiers_have_valid_check_digits():
    for serial in [*range(1, 60), 99_999]:
        for legal_form in ("OOO", "IP"):
            assert is_valid_inn(make_inn(serial, legal_form)), (serial, legal_form)
            assert is_valid_ogrn(make_ogrn(serial, legal_form)), (serial, legal_form)
    assert len(make_inn(1, "OOO")) == 10 and len(make_inn(1, "IP")) == 12
    assert len(make_ogrn(1, "OOO")) == len(make_ogrn(99_999, "OOO")) == 13
    assert len(make_ogrn(1, "IP")) == len(make_ogrn(999_999, "IP")) == 15


def test_generated_identifiers_do_not_overlap_builtin_companies():
    """ИНН и ОГРН созданных компаний не совпадают со встроенными: у первой созданной ООО ОГРН был таким же,
    как у «Северного ветра» (1007700000010)."""
    assert make_inn(1, "OOO").startswith("0020"), "у созданных компаний свой префикс, отличный от companies.json"
    for serial in [*range(1, 2000), 99_999]:
        for legal_form in ("OOO", "IP"):
            assert make_inn(serial, legal_form) not in BUILTIN, (serial, legal_form)
            assert make_ogrn(serial, legal_form) not in BUILTIN_OGRNS, (serial, legal_form)
    assert make_ogrn(1, "OOO") != BUILTIN["0010000017"]["egrul"]["ogrn"]


def test_created_company_is_visible_in_all_sources():
    created = client.post("/companies", json=STABLE)
    assert created.status_code == 201, created.text
    inn = created.json()["inn"]
    assert is_valid_inn(inn)
    assert created.json()["egrul"]["name"] == "ООО «Полярная звезда»"
    assert created.json()["bank"]["is_client"] is True

    egrul = client.get(f"/egrul/{inn}").json()
    assert egrul["legal_form"] == "OOO" and egrul["status"] == "ACTIVE" and egrul["okved"] == "46.39"
    assert is_valid_ogrn(egrul["ogrn"]) and egrul["ogrn"] not in BUILTIN_OGRNS
    assert egrul["registration_date"] == egrul["director"]["since"]

    fns = client.get(f"/fns/{inn}").json()
    assert fns["tax_debt"] == 0 and fns["mass_address"] is False and fns["employees"] == 20

    girbo = client.get(f"/girbo/{inn}").json()
    assert girbo["available"] is True
    assert [y["revenue"] for y in girbo["years"]] == [60_000_000, half_up(60_000_000 / 1.12)]
    assert girbo["years"][0]["sales_profit"] == 6_000_000
    assert girbo["years"][0]["year"] - girbo["years"][1]["year"] == 1

    bki = client.post("/bki/report", json={"inn": inn, "consent_id": "c-1"}).json()
    assert bki["has_history"] is True and bki["current_overdue_days"] == 0
    assert [loan["monthly_payment"] for loan in bki["loans"]] == [150_000]

    bank = client.get(f"/bank/clients/{inn}").json()
    assert bank["is_client"] is True and len(bank["months"]) == 12
    assert bank["months"][0]["month"] < bank["months"][-1]["month"]
    inflows = [m["inflow"] for m in bank["months"]]
    assert sum(inflows) / 12 == 5_000_000, "сумма коэффициентов ряда — ровно 12"
    assert max(inflows) <= 5_000_000 * 1.05 and min(inflows) >= 5_000_000 * 0.95

    persona = client.get(f"/companies/{inn}").json()
    assert persona["custom"] is True and persona["spec"]["name"] == "Полярная звезда"
    assert any(row["inn"] == inn for row in client.get("/admin/companies").json())


def test_individual_entrepreneur_without_reports_and_credits():
    spec = {
        **STABLE,
        "name": "Соколова Мария Ивановна",
        "legal_form": "IP",
        "registered_months_ago": 30,
        "existing_monthly_payments": 0,
        "is_bank_client": False,
        "account_months": 0,
        "avg_monthly_inflow": 0,
    }
    inn = client.post("/companies", json=spec).json()["inn"]
    assert len(inn) == 12 and is_valid_inn(inn)
    egrul = client.get(f"/egrul/{inn}").json()
    assert egrul["name"] == "ИП Соколова Мария Ивановна"
    assert egrul["director"]["name"] == "Соколова Мария Ивановна"
    assert len(egrul["ogrn"]) == 15
    assert client.get(f"/girbo/{inn}").json()["available"] is False
    bki = client.post("/bki/report", json={"inn": inn, "consent_id": "c-1"}).json()
    assert bki["has_history"] is False and bki["loans"] == []
    assert client.get(f"/bank/clients/{inn}").json() == {"inn": inn, "is_client": False, "months": []}


def test_young_company_has_short_history_and_stop_factor_data():
    spec = {
        **STABLE,
        "name": "Ромашка-Строй 2",
        "registered_months_ago": 5,
        "account_months": 5,
        "company_status": "LIQUIDATING",
        "current_overdue_days": 40,
        "max_overdue_days_24m": 10,
    }
    inn = client.post("/companies", json=spec).json()["inn"]
    assert client.get(f"/egrul/{inn}").json()["status"] == "LIQUIDATING"
    assert client.get(f"/girbo/{inn}").json() == {"inn": inn, "available": False, "years": []}
    assert len(client.get(f"/bank/clients/{inn}").json()["months"]) == 5
    bki = client.post("/bki/report", json={"inn": inn, "consent_id": "c-1"}).json()
    assert bki["max_overdue_days_24m"] == 40, "максимальная просрочка не меньше текущей"


def test_same_description_gives_same_data():
    spec = CompanySpec(**STABLE)
    inn, ogrn = make_inn(1, "OOO"), make_ogrn(1, "OOO")
    first = build_persona(spec, inn, ogrn, "2026-10-24T00:00:00+00:00")
    second = build_persona(spec, inn, ogrn, "2026-10-24T00:00:00+00:00")
    assert first == second
    assert sum(first["bank"]["inflow_pattern"]) == sum(INFLOW_PATTERN)
    other = build_persona(CompanySpec(**{**STABLE, "name": "Белые ночи"}), inn, ogrn, "")
    assert other["egrul"]["address"] != first["egrul"]["address"]


def test_bad_description_is_rejected():
    assert client.post("/companies", json={**STABLE, "revenue": 0}).status_code == 422
    assert client.post("/companies", json={**STABLE, "legal_form": "AO"}).status_code == 422


def test_custom_companies_survive_restart(tmp_path: Path):
    path = tmp_path / "custom.json"
    builtin = {"0010000017": {"persona": "Встроенная", "egrul": {"name": "ООО «Северный ветер»"}}}
    store = CompanyStore(builtin, path)
    inn = store.register(CompanySpec(**STABLE))
    assert inn in store.data and path.exists()

    restarted = CompanyStore(builtin, path)
    assert restarted.data[inn]["egrul"]["name"] == "ООО «Полярная звезда»"
    assert restarted.data["0010000017"]["persona"] == "Встроенная"
    second = restarted.register(CompanySpec(**{**STABLE, "name": "Белые ночи"}))
    assert second != inn and set(CompanyStore(builtin, path).custom) == {inn, second}


def test_store_without_file_keeps_companies_in_memory():
    store = CompanyStore({}, None)
    inn = store.register(CompanySpec(**STABLE))
    assert store.data[inn]["custom"] is True
