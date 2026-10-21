"""Сквозные сценарии через API на запущенном стеке (docker compose или локально).

Запуск: API_URL=http://localhost:8080 pytest tests/integration
Каждый сценарий соответствует тестовой компании из docs/test-scenarios.md.
"""

import os
import time
import uuid
from pathlib import Path

import httpx
import pytest

API = os.getenv("API_URL", "http://localhost:8000")
DEMO_FILES = Path(__file__).resolve().parents[3] / "frontend" / "public" / "demo-files"
PROCESSING = {"SUBMITTED", "IN_PROCESSING", "ACCEPTED", "SIGNED"}

pytestmark = pytest.mark.skipif(os.getenv("RUN_INTEGRATION") != "1", reason="нужен запущенный стек: RUN_INTEGRATION=1")


class Client:
    def __init__(self, login: str, password: str = "demo") -> None:
        self.http = httpx.Client(base_url=API, timeout=30)
        response = self.http.post("/api/auth/login", json={"login": login, "password": password})
        response.raise_for_status()
        self.http.headers["Authorization"] = f"Bearer {response.json()['token']}"
        self.user = response.json()["user"]

    def get(self, url: str, **kwargs):
        response = self.http.get(url, **kwargs)
        assert response.status_code < 400, response.text
        return response.json()

    def post(self, url: str, expect: int = 200, **kwargs):
        response = self.http.post(url, **kwargs)
        assert response.status_code == expect, response.text
        return response.json() if response.content else None


def wait(client: Client, application_id: str, until: set[str] | None = None, timeout: float = 60) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        application = client.get(f"/api/applications/{application_id}")
        status = application["status"]
        if (until and status in until) or (until is None and status not in PROCESSING):
            return application
        assert time.monotonic() < deadline, f"заявка зависла в статусе {status}"
        time.sleep(0.5)


def apply(client: Client, product: str, amount: int, term: int, purpose: str = "WORKING_CAPITAL", **extra) -> dict:
    draft = client.post(
        "/api/applications",
        expect=201,
        json={
            "product_code": product,
            "purpose": purpose,
            "amount": amount,
            "term_months": term,
            "purpose_text": "Тестовая заявка",
            **extra,
        },
    )
    key = str(uuid.uuid4())
    client.post(
        f"/api/applications/{draft['id']}/submit",
        json={"consent_bki": True, "consent_pd": True},
        headers={"Idempotency-Key": key},
    )
    # Повтор с тем же ключом не создаёт дубликат и не падает.
    client.post(
        f"/api/applications/{draft['id']}/submit",
        json={"consent_bki": True, "consent_pd": True},
        headers={"Idempotency-Key": key},
    )
    return wait(client, draft["id"])


def accept_sign_issue(client: Client, application: dict, option: int = 0) -> dict:
    offer = application["offers"][option]
    client.post(f"/api/offers/{offer['id']}/accept")
    signing = wait(client, application["id"], until={"SIGNING"})
    agreement = next(d for d in signing["documents"] if d["kind"] == "AGREEMENT")
    pdf = client.http.get(f"/api/documents/{agreement['id']}/download")
    assert pdf.content.startswith(b"%PDF")
    client.post(
        f"/api/applications/{application['id']}/sign",
        json={"password": "demo"},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    issued = wait(client, application["id"], until={"ISSUED"})
    assert issued["loan"]["schedule"][-1]["balance"] == "0.00"
    return issued


def test_auto_approval_and_issue():
    client = Client("veter")
    application = apply(client, "GROWTH", 3_000_000, 24)
    assert application["status"] == "OFFER"
    [offer] = application["offers"]
    assert offer["kind"] == "AS_REQUESTED"
    assert application["explanation"]["positive"]
    issued = accept_sign_issue(client, application)
    assert len(issued["loan"]["schedule"]) == 24


def test_overdraft_counter_offer_limited_by_inflows():
    client = Client("smirnova")
    application = apply(client, "OVERDRAFT", 1_000_000, 12, purpose="CASH_GAP")
    assert application["status"] == "OFFER"
    assert [float(o["amount"]) for o in application["offers"]] == [440000.0]
    assert application["explanation"]["limit_phrase"]


def test_counter_offer_with_two_options():
    client = Client("tehnomaster")
    application = apply(client, "GROWTH", 6_000_000, 24)
    assert application["status"] == "OFFER"
    options = [(float(o["amount"]), o["term_months"]) for o in application["offers"]]
    assert options[0] == (6_000_000.0, 60)
    assert options[1][1] == 24 and options[1][0] < 6_000_000


def test_statement_request_then_automatic_decision():
    client = Client("orlov")
    application = apply(client, "EXPRESS", 1_500_000, 24)
    assert application["status"] == "NEED_INFO"
    request = next(r for r in application["info_requests"] if r["status"] == "OPEN")
    with open(DEMO_FILES / "vypiska_orlov_1c.txt", "rb") as file:
        document = client.post(
            f"/api/applications/{application['id']}/documents",
            expect=201,
            files={"file": ("vypiska_orlov_1c.txt", file, "text/plain")},
            data={"kind": "BANK_STATEMENT", "info_request_id": request["id"]},
        )
    assert document["parsed"]["avg_monthly_inflow"] == pytest.approx(700000, rel=0.01)
    client.post(f"/api/info-requests/{request['id']}/answer", json={"text": "Выписка за 12 месяцев"})
    application = wait(client, application["id"])
    assert application["status"] == "OFFER"
    assert application["offers"][0]["kind"] == "AS_REQUESTED"


def test_liquidating_company_rejected_by_stop_factor():
    client = Client("romashka")
    application = apply(client, "GROWTH", 2_000_000, 24)
    assert application["status"] == "REJECTED"
    assert "ликвидации" in application["explanation"]["rejection"][0]


def test_current_overdue_rejected():
    client = Client("meridian")
    application = apply(client, "GROWTH", 2_000_000, 24)
    assert application["status"] == "REJECTED"
    assert "просроченный долг" in application["explanation"]["rejection"][0]


def test_manual_review_info_request_and_counter_offer():
    client = Client("vektor")
    analyst = Client("analyst")
    application = apply(client, "GROWTH", 12_000_000, 36, purpose="EXPANSION", declared_revenue=36_000_000)
    assert application["status"] == "MANUAL_REVIEW"

    dossier = analyst.get(f"/api/bank/applications/{application['id']}/dossier")
    assert {f["code"] for f in dossier["auto_decision"]["flags"]} == {"F01", "F02"}
    assert dossier["scoring"]["risk_class"] == "B"
    limit = dossier["limit"]["limit"]

    analyst.post(
        f"/api/bank/applications/{application['id']}/info-requests",
        json={"items": ["TAX_EXPLANATION"], "comment": "Поясните задолженность", "due_hours": 48},
    )
    request = next(
        r for r in client.get(f"/api/applications/{application['id']}")["info_requests"] if r["status"] == "OPEN"
    )
    client.post(f"/api/info-requests/{request['id']}/answer", json={"text": "Погасим до конца месяца"})
    assert client.get(f"/api/applications/{application['id']}")["status"] == "MANUAL_REVIEW"

    over_limit = analyst.http.post(
        f"/api/bank/applications/{application['id']}/decision",
        json={"action": "COUNTER", "amount": round(limit * 1.1), "term_months": 36},
    )
    assert over_limit.status_code == 422, "без комментария превышать лимит нельзя"
    analyst.post(
        f"/api/bank/applications/{application['id']}/decision",
        json={
            "action": "COUNTER",
            "amount": round(limit * 1.1, -4),
            "term_months": 36,
            "comment": "Стабильные поступления на счёт, задолженность погашается",
        },
    )
    application = client.get(f"/api/applications/{application['id']}")
    assert application["status"] == "OFFER"
    assert application["offers"][0]["kind"] == "COUNTER"


def test_young_business_goes_to_analyst_and_is_rejected():
    client = Client("start")
    quote = client.post(
        "/api/calculator/quote",
        json={
            "purpose": "WORKING_CAPITAL",
            "amount": 1_500_000,
            "term_months": 24,
            "business_months": 5,
            "is_bank_client": True,
            "account_months": 5,
        },
    )
    assert quote[0]["product"]["code"] == "STARTUP" and quote[0]["eligible"]
    assert not next(q for q in quote if q["product"]["code"] == "GROWTH")["eligible"]
    application = apply(client, "STARTUP", 1_500_000, 24)
    assert application["status"] == "MANUAL_REVIEW"
    analyst = Client("analyst2")
    analyst.post(
        f"/api/bank/applications/{application['id']}/decision",
        json={"action": "REJECT", "reason_code": "R01", "comment": "Недостаточная история бизнеса"},
    )
    assert client.get(f"/api/applications/{application['id']}")["status"] == "REJECTED"


def test_source_outage_waits_and_recovers():
    admin = Client("admin")
    client = Client("altair")
    admin.http.put("/api/admin/simulator/faults/bki", json={"mode": "error"}).raise_for_status()
    try:
        draft = client.post(
            "/api/applications",
            expect=201,
            json={"product_code": "EXPRESS", "purpose": "WORKING_CAPITAL", "amount": 2_000_000, "term_months": 12},
        )
        client.post(f"/api/applications/{draft['id']}/submit", json={"consent_bki": True, "consent_pd": True})
        deadline = time.monotonic() + 30
        while True:
            application = client.get(f"/api/applications/{draft['id']}")
            bki = next((s for s in application["steps"] if s["step"] == "BKI"), None)
            if bki and bki["status"] == "WAITING":
                break
            assert time.monotonic() < deadline, "шаг БКИ не перешёл в ожидание"
            time.sleep(0.5)
        assert application["status"] == "IN_PROCESSING"
    finally:
        admin.post("/api/admin/simulator/faults/reset")
    analyst = Client("analyst")
    analyst.post(f"/api/bank/applications/{draft['id']}/pipeline/retry")
    application = wait(client, draft["id"], timeout=90)
    assert application["status"] == "OFFER"


def test_client_cannot_see_other_company_application():
    owner = Client("veter")
    stranger = Client("smirnova")
    draft = owner.post(
        "/api/applications",
        expect=201,
        json={"product_code": "GROWTH", "purpose": "EXPANSION", "amount": 2_000_000, "term_months": 24},
    )
    assert stranger.http.get(f"/api/applications/{draft['id']}").status_code == 404
    assert stranger.http.post("/api/bank/applications/x/assign").status_code in (403, 422)


def test_invalid_transition_is_rejected():
    client = Client("veter")
    draft = client.post(
        "/api/applications",
        expect=201,
        json={"product_code": "GROWTH", "purpose": "EXPANSION", "amount": 2_000_000, "term_months": 24},
    )
    response = client.http.post(f"/api/applications/{draft['id']}/decline")
    assert response.status_code == 409
