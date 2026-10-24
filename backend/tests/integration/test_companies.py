"""Своя тестовая компания (docs/test-scenarios.md, С15): администратор создаёт компанию через конструктор,
под новым логином подают заявку, исход считает конвейер по общим правилам.

Запуск: RUN_INTEGRATION=1 API_URL=http://localhost:8080 pytest tests/integration -k companies
"""

import os

import pytest

from tests.integration.test_flows import Client, apply

pytestmark = pytest.mark.skipif(os.getenv("RUN_INTEGRATION") != "1", reason="нужен запущенный стек: RUN_INTEGRATION=1")

# Устойчивая компания: 6 лет работы, растущая прибыльная выручка, без кредитов и долгов, клиент банка 3 года
STABLE = {
    "name": "Полярная звезда",
    "legal_form": "OOO",
    "registered_months_ago": 72,
    "okved": "46.39",
    "revenue": 60_000_000,
    "revenue_growth": 0.12,
    "margin": 0.1,
    "existing_monthly_payments": 0,
    "max_overdue_days_24m": 0,
    "current_overdue_days": 0,
    "tax_debt": 0,
    "mass_address": False,
    "director_disqualified": False,
    "company_status": "ACTIVE",
    "is_bank_client": True,
    "account_months": 36,
    "avg_monthly_inflow": 5_000_000,
}


def test_admin_creates_stable_company_and_its_application_is_approved():
    admin = Client("admin")
    created = admin.post("/api/admin/companies", expect=201, json=STABLE)
    assert created["password"] == "demo"
    assert created["login"].startswith("polyarnayazvezda")
    company = created["company"]
    assert created["inn"] == company["inn"] and company["inn"].startswith("0020")
    assert company["name"] == "ООО «Полярная звезда»" and company["legal_form"] == "OOO"
    assert company["okved"] == "46.39" and company["status"] == "ACTIVE"
    assert company["business_months"] == 72 and company["account_months"] == 36 and company["is_bank_client"]

    # Под новым логином можно сразу войти и подать заявку
    client = Client(created["login"])
    assert client.user["role"] == "CLIENT" and client.user["can_sign"]
    assert client.user["company"]["inn"] == created["inn"]
    assert client.user["full_name"] == company["director_name"]
    application = apply(client, "GROWTH", 2_000_000, 24, purpose="EXPANSION")
    assert application["status"] == "OFFER", application["history"]
    [offer] = application["offers"]
    assert offer["kind"] == "AS_REQUESTED" and float(offer["amount"]) == 2_000_000 and offer["term_months"] == 24
    assert {step["status"] for step in application["steps"]} == {"DONE"}, "у ООО есть отчётность и счёт в банке"

    # Запись в журнале действий администратора
    rows = admin.get("/api/admin/audit")
    created_row = next(row for row in rows if row["action"] == "COMPANY_CREATED" and row["entity_id"] == company["id"])
    assert created_row["details"]["login"] == created["login"] and created_row["details"]["inn"] == created["inn"]


def test_liquidating_company_is_rejected_by_stop_factor():
    admin = Client("admin")
    created = admin.post("/api/admin/companies", expect=201, json={**STABLE, "company_status": "LIQUIDATING"})
    client = Client(created["login"])
    application = apply(client, "GROWTH", 2_000_000, 24, purpose="EXPANSION")
    assert application["status"] == "REJECTED"
    assert "ликвидации" in application["explanation"]["rejection"][0]


def test_company_builder_checks_role_and_parameters():
    admin = Client("admin")
    analyst = Client("analyst")
    assert analyst.http.post("/api/admin/companies", json=STABLE).status_code == 403
    options = analyst.get("/api/admin/companies/options")
    assert {item["code"] for item in options["okved"]} >= {"46.39", "41.20", "62.01"}

    empty_name = admin.http.post("/api/admin/companies", json={**STABLE, "name": "   "})
    assert empty_name.status_code == 422
    assert [item["msg"] for item in empty_name.json()["detail"]] == ["Укажите название компании"]

    overdue = admin.http.post("/api/admin/companies", json={**STABLE, "current_overdue_days": 40})
    assert overdue.status_code == 422
    assert overdue.json()["detail"][0]["msg"] == "Максимальная просрочка за 24 месяца не может быть меньше текущей"
