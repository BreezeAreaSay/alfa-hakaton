"""Сквозные сценарии через API на запущенном стеке (docker compose или локально).

Запуск: API_URL=http://localhost:8080 pytest tests/integration
Каждый сценарий соответствует тестовой компании из docs/test-scenarios.md.
"""

import os
import time
import uuid
from datetime import datetime
from pathlib import Path

import httpx
import pytest

API = os.getenv("API_URL", "http://localhost:8000")
DEMO_FILES = Path(__file__).resolve().parents[3] / "frontend" / "public" / "demo-files"
PROCESSING = {"SUBMITTED", "IN_PROCESSING", "ACCEPTED", "SIGNED"}

pytestmark = pytest.mark.skipif(os.getenv("RUN_INTEGRATION") != "1", reason="нужен запущенный стек: RUN_INTEGRATION=1")


class Client:
    def __init__(self, login: str, password: str = "admin") -> None:
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
        json={"password": "admin"},
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
    explanation = application["explanation"]
    assert explanation["positive"]
    # Из чего складывается ставка: ключевая + спред продукта + надбавка за риск = ставка предложения
    breakdown = explanation["rate_breakdown"]
    parts = (breakdown["key_rate"], breakdown["product_spread"], breakdown["risk_margin"], breakdown["adjustment"])
    assert sum(float(x) for x in parts) == pytest.approx(float(offer["rate"]))
    assert float(breakdown["rate"]) == pytest.approx(float(offer["rate"]))
    # Как получить ставку ниже: под пополнение оборотки дешевле кредитная линия, она доступна клиенту банка
    assert any(h["kind"] == "product" and h["product_code"] == "CREDIT_LINE" for h in explanation["rate_hints"])
    issued = accept_sign_issue(client, application)
    assert len(issued["loan"]["schedule"]) == 24


def test_overdraft_counter_offer_limited_by_inflows():
    client = Client("smirnova")
    application = apply(client, "OVERDRAFT", 1_000_000, 12, purpose="CASH_GAP")
    assert application["status"] == "OFFER"
    assert [float(o["amount"]) for o in application["offers"]] == [440000.0]
    assert application["explanation"]["limit_phrase"]
    assert float(application["explanation"]["rate_breakdown"]["rate"]) == pytest.approx(
        float(application["offers"][0]["rate"])
    )


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
    assert "после завершения ликвидации" in application["explanation"]["next_steps"][0]


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


def review_loads(analyst: Client, names: dict[str, str]) -> dict[str, int]:
    """Сколько заявок на ручном рассмотрении у каждого аналитика — когда конвейер ничего не обрабатывает
    и загрузка не может измениться, пока тест отправляет свою заявку."""
    deadline = time.monotonic() + 90
    while analyst.get("/api/bank/applications", params={"status": ["SUBMITTED", "IN_PROCESSING"]}):
        assert time.monotonic() < deadline, "конвейер не освободился"
        time.sleep(0.5)
    rows = analyst.get("/api/bank/applications", params={"status": "MANUAL_REVIEW"})
    return {login: sum(1 for r in rows if r["assignee_name"] == name) for login, name in names.items()}


def test_manual_review_is_assigned_automatically_with_priority_and_can_be_taken_over():
    """Умная очередь (docs/process.md, «Очередь аналитиков»): заявка на ручном рассмотрении сразу у аналитика
    с наименьшей загрузкой, в очереди и досье — приоритет с причинами, «Взять себе» передаёт её другому."""
    client, analyst, analyst2 = Client("vektor"), Client("analyst"), Client("analyst2")
    staff = {"analyst": analyst, "analyst2": analyst2}
    names = {login: c.user["full_name"] for login, c in staff.items()}
    loads = review_loads(analyst, names)
    expected = min(loads, key=lambda login: (loads[login], login))

    application = apply(client, "GROWTH", 12_000_000, 36, purpose="EXPANSION", declared_revenue=36_000_000)
    assert application["status"] == "MANUAL_REVIEW"
    app_id = application["id"]

    rows = analyst.get("/api/bank/applications", params={"status": "MANUAL_REVIEW"})
    row = next(r for r in rows if r["id"] == app_id)
    assert row["assignee_name"] == names[expected]
    assert row["priority"] == "MEDIUM"
    assert row["priority_reasons"] == ["Сумма от 10 млн ₽", "Флаги F01, F02 требуют проверки"]
    # Сверху высокий приоритет, внутри приоритета — ближайший срок рассмотрения
    rank = {"HIGH": 0, "MEDIUM": 1, "NORMAL": 2}
    order = [(rank[r["priority"]], datetime.fromisoformat(r["sla_due_at"])) for r in rows]
    assert order == sorted(order)

    dossier = analyst.get(f"/api/bank/applications/{app_id}/dossier")
    assert (dossier["priority"], dossier["priority_reasons"]) == (row["priority"], row["priority_reasons"])
    assert dossier["assignee"] == names[expected]
    [auto] = [r for r in dossier["audit"] if r["action"] == "ASSIGNED"]
    assert auto["details"] == {"auto": True, "to": expected} and auto["actor"] == "SYSTEM"

    # «Вам назначена заявка» — личное уведомление: его видит только назначенный аналитик
    title = f"Вам назначена заявка № {application['number']}"
    for login, c in [*staff.items(), ("admin", Client("admin"))]:
        titles = [n["title"] for n in c.get("/api/notifications")["items"]]
        assert (title in titles) == (login == expected), login

    # «Взять себе»: analyst2 забирает заявку у коллеги; если она досталась ему самому, сначала её забирает analyst
    if expected == "analyst2":
        analyst.post(f"/api/bank/applications/{app_id}/assign")
    analyst2.post(f"/api/bank/applications/{app_id}/assign")
    analyst2.post(f"/api/bank/applications/{app_id}/assign")  # своя заявка: ничего не меняет
    dossier = analyst2.get(f"/api/bank/applications/{app_id}/dossier")
    assert dossier["assignee"] == names["analyst2"] and dossier["assignee_is_me"]
    moves = [r for r in dossier["audit"] if r["action"] == "ASSIGNED"]
    assert moves[0]["details"] == {"from": "analyst", "to": "analyst2"} and moves[0]["user"] == names["analyst2"]
    assert moves[-1]["details"] == {"auto": True, "to": expected}
    assert len(moves) == (3 if expected == "analyst2" else 2)
    mine = analyst2.get("/api/bank/applications", params={"mine": "true"})
    assert any(r["id"] == app_id and r["assignee_is_me"] for r in mine)

    # Заявку можно отозвать как обычно; в очереди у завершённых приоритета нет
    client.post(f"/api/applications/{app_id}/cancel")
    closed = analyst.get("/api/bank/applications", params={"status": "CANCELLED"})
    assert next(r for r in closed if r["id"] == app_id)["priority"] is None


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


def test_draft_with_document_can_be_deleted():
    client = Client("veter")
    draft = client.post(
        "/api/applications",
        expect=201,
        json={"product_code": "GROWTH", "purpose": "EXPANSION", "amount": 2_000_000, "term_months": 24},
    )
    client.post(
        f"/api/applications/{draft['id']}/documents",
        expect=201,
        files={"file": ("plan.txt", b"business plan", "text/plain")},
        data={"kind": "OTHER"},
    )
    assert client.http.delete(f"/api/applications/{draft['id']}").status_code == 204
    assert client.http.get(f"/api/applications/{draft['id']}").status_code == 404


def test_invalid_requests_are_rejected_with_clear_errors():
    client = Client("veter")
    admin = Client("admin")
    analyst = Client("analyst")
    draft = client.post(
        "/api/applications",
        expect=201,
        json={"product_code": "GROWTH", "purpose": "EXPANSION", "amount": 2_000_000, "term_months": 24},
    )
    too_long_key = client.http.post(
        f"/api/applications/{draft['id']}/submit",
        json={"consent_bki": True, "consent_pd": True},
        headers={"Idempotency-Key": "x" * 129},
    )
    assert too_long_key.status_code == 422
    assert admin.http.put("/api/admin/simulator/faults/unknown", json={"mode": "error"}).status_code == 404
    foreign_request = client.http.post(
        f"/api/applications/{draft['id']}/documents",
        files={"file": ("note.txt", b"note", "text/plain")},
        data={"kind": "OTHER", "info_request_id": str(uuid.uuid4())},
    )
    assert foreign_request.status_code == 422
    assert analyst.http.get(f"/api/applications/{draft['id']}").status_code == 404, "черновик видит только клиент"
    assert client.http.patch(f"/api/applications/{draft['id']}", json={"amount": None}).status_code == 422
    cleared = client.http.patch(f"/api/applications/{draft['id']}", json={"purpose_text": None})
    assert cleared.status_code == 200 and cleared.json()["purpose_text"] is None


def test_demo_reset_keeps_event_ids_growing():
    admin = Client("admin")
    client = Client("veter")
    apply(client, "GROWTH", 3_000_000, 24)
    before = max(item["id"] for item in client.get("/api/notifications")["items"])
    admin.post("/api/admin/demo/reset")
    apply(client, "GROWTH", 3_000_000, 24)
    after = min(item["id"] for item in client.get("/api/notifications")["items"])
    assert after > before, "после сброса открытые вкладки должны продолжать получать события"


def test_bank_metrics_reflect_period():
    # Показатели считаются по заявкам, поданным за период; к этому моменту сценарии выше уже создали заявки
    analyst = Client("analyst")
    metrics = analyst.get("/api/bank/metrics", params={"days": 30})
    assert metrics["submitted"] >= metrics["decided"] >= 1
    assert metrics["auto_decided"] + metrics["manual_decided"] == metrics["decided"]
    assert 0 <= metrics["automation_share"] <= 1
    assert {o["code"] for o in metrics["outcomes"]} <= {"APPROVE", "COUNTER", "REJECT"}
    assert sum(o["count"] for o in metrics["outcomes"]) == metrics["decided"]
    assert metrics["to_decision_median_seconds"] is not None and metrics["to_decision_median_seconds"] > 0
    assert len(metrics["daily"]) == 30 and sum(d["submitted"] for d in metrics["daily"]) == metrics["submitted"]
    assert sum(p["applications"] for p in metrics["products"]) == metrics["submitted"]
    assert {a["name"] for a in metrics["analysts"]}
    assert Client("analyst").http.get("/api/bank/metrics", params={"days": 0}).status_code == 422
    # Клиенту показатели банка недоступны
    assert Client("veter").http.get("/api/bank/metrics").status_code == 403


def test_statement_forecast_predicts_cash_gap():
    # Выписку можно приложить к черновику по желанию: по ней строится прогноз кассового разрыва
    client = Client("smirnova")
    draft = client.post(
        "/api/applications",
        expect=201,
        json={"product_code": "OVERDRAFT", "purpose": "CASH_GAP", "amount": 500_000, "term_months": 12},
    )
    with open(DEMO_FILES / "vypiska_smirnova.csv", "rb") as file:
        document = client.post(
            f"/api/applications/{draft['id']}/documents",
            expect=201,
            data={"kind": "BANK_STATEMENT"},
            files={"file": ("vypiska_smirnova.csv", file, "text/csv")},
        )
    forecast = document["parsed"]["forecast"]
    assert document["parsed"]["closing_balance"] is None and forecast["balance_known"] is False
    assert len(forecast["months"]) == 3 and forecast["gap"] > 0
    assert forecast["recommendation"]["product"] == "OVERDRAFT"
    assert forecast["recommendation"]["amount"] <= forecast["overdraft_cap"]
    # Выписка 1С с остатком на счёте: разрыва нет
    orlov = Client("orlov")
    draft = orlov.post(
        "/api/applications",
        expect=201,
        json={"product_code": "EXPRESS", "purpose": "WORKING_CAPITAL", "amount": 500_000, "term_months": 12},
    )
    with open(DEMO_FILES / "vypiska_orlov_1c.txt", "rb") as file:
        document = orlov.post(
            f"/api/applications/{draft['id']}/documents",
            expect=201,
            data={"kind": "BANK_STATEMENT"},
            files={"file": ("vypiska_orlov_1c.txt", file, "text/plain")},
        )
    assert document["parsed"]["closing_balance"] == 7_026_000
    assert document["parsed"]["forecast"]["recommendation"]["reason"] == "NO_GAP"


def test_proactive_offers_follow_company_data():
    # Предварительные предложения на главной: по ЕГРЮЛ, отчётности и оборотам, без заявки
    veter = Client("veter").get("/api/offers/proactive")
    assert [o["product_code"] for o in veter["offers"]] == ["OVERDRAFT", "GROWTH"]
    assert veter["offers"][0]["amount"] == 4_000_000 and veter["offers"][1]["amount"] == 10_000_000
    assert any(fact.startswith("Выручка по отчётности") for fact in veter["facts"])
    assert veter["note"].startswith("Предварительно")
    # Ликвидация — предложений нет; ИП со счётом два месяца — нет данных о выручке, есть подсказка
    assert Client("romashka").get("/api/offers/proactive")["offers"] == []
    orlov = Client("orlov").get("/api/offers/proactive")
    assert orlov["offers"] == [] and "выписку" in orlov["note"]
    # Аналитику метод недоступен
    assert Client("analyst").http.get("/api/offers/proactive").status_code == 403


def test_justification_pdf_for_analyst_queue_application():
    # Обоснование решения для аудита: берём заявку из очереди аналитика, у которой уже есть результат скоринга
    analyst = Client("analyst")
    deadline = time.monotonic() + 60
    while True:
        rows = analyst.get("/api/bank/applications", params={"include_closed": "true"})
        scored = [r for r in rows if r["score"] is not None]
        if scored:
            break
        assert time.monotonic() < deadline, "в очереди нет заявок с результатом скоринга"
        time.sleep(0.5)
    scored.sort(key=lambda r: r["status"] != "MANUAL_REVIEW")
    application = scored[0]
    response = analyst.http.get(f"/api/bank/applications/{application['id']}/justification.pdf")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith("attachment; filename*=UTF-8''")
    assert response.content.startswith(b"%PDF") and len(response.content) > 2048
    dossier = analyst.get(f"/api/bank/applications/{application['id']}/dossier")
    assert any(row["action"] == "JUSTIFICATION_GENERATED" for row in dossier["audit"])
    # Администратору обоснование доступно, клиенту — нет
    assert Client("admin").http.get(f"/api/bank/applications/{application['id']}/justification.pdf").status_code == 200
    assert Client("veter").http.get(f"/api/bank/applications/{application['id']}/justification.pdf").status_code == 403


def test_preliminary_offers_by_statement():
    # «Сколько одобрят по выписке» на главной: файл разбирается, заявка не создаётся
    client = Client("smirnova")
    with open(DEMO_FILES / "vypiska_smirnova.csv", "rb") as file:
        result = client.post("/api/offers/preliminary", files={"file": ("vypiska_smirnova.csv", file, "text/csv")})
    assert result["statement"]["forecast"]["gap"] > 0
    overdraft = next(o for o in result["offers"] if o["product_code"] == "OVERDRAFT")
    assert float(overdraft["amount"]) <= float(result["statement"]["avg_monthly_inflow"]) * 0.4
    assert result["facts"][0].startswith("По выписке")
    bad = client.http.post("/api/offers/preliminary", files={"file": ("x.csv", b"not a statement", "text/csv")})
    assert bad.status_code == 422


def test_login_is_blocked_after_repeated_wrong_passwords():
    """Перебор паролей: после пяти неверных паролей логин с этого адреса блокируется на 5 минут — 429 и Retry-After."""
    http = httpx.Client(base_url=API, timeout=30)
    statuses = []
    for _ in range(7):
        response = http.post("/api/auth/login", json={"login": "nobody", "password": "wrong"})
        statuses.append(response.status_code)
        if response.status_code == 429:
            assert int(response.headers["Retry-After"]) > 0
            assert response.json()["detail"].startswith("Слишком много попыток входа. Повторите через")
            break
    assert statuses[-1] == 429 and statuses.count(401) <= 5, statuses
    # другие пользователи входят как обычно
    assert Client("analyst").user["role"] == "UNDERWRITER"
    # неудачные попытки видны в журнале действий
    rows = Client("admin").get("/api/admin/audit")
    failed = [r for r in rows if r["action"] == "LOGIN_FAILED" and r["details"].get("login") == "nobody"]
    assert failed and failed[0]["details"]["blocked_seconds"] and failed[0]["actor"] == "SYSTEM"


def test_support_chat_between_client_and_admin():
    # Клиент пишет в поддержку, администратор видит его в колонке чатов, читает и отвечает
    client, admin = Client("tehnomaster"), Client("admin")
    client_id = client.user["id"]
    text = f"Не могу найти договор, {uuid.uuid4().hex[:6]}"
    sent = client.post("/api/support/messages", expect=201, json={"text": text})
    assert sent["author_role"] == "CLIENT" and sent["text"] == text

    thread = next(t for t in admin.get("/api/support/threads") if t["client_id"] == client_id)
    assert thread["last_text"] == text and thread["unread"] >= 1
    assert thread["company_name"] == client.user["company"]["name"]
    assert admin.get(f"/api/support/threads/{client_id}")["messages"][-1]["text"] == text
    admin.post(f"/api/support/threads/{client_id}/read", expect=204)
    assert admin.get(f"/api/support/threads/{client_id}")["unread"] == 0

    admin.post(f"/api/support/threads/{client_id}/messages", expect=201, json={"text": "Договор — в карточке заявки"})
    mine = client.get("/api/support")
    assert mine["messages"][-1]["author_role"] == "ADMIN" and mine["unread"] >= 1
    client.post("/api/support/read", expect=204)
    assert client.get("/api/support")["unread"] == 0

    # Колонка чатов — только у администратора, писать в поддержку — только клиенту
    assert Client("analyst").http.get("/api/support/threads").status_code == 403
    assert client.http.get("/api/support/threads").status_code == 403
    assert admin.http.post("/api/support/messages", json={"text": "вопрос"}).status_code == 403
    assert admin.http.post(f"/api/support/threads/{uuid.uuid4()}/messages", json={"text": "ответ"}).status_code == 404
    assert client.http.post("/api/support/messages", json={"text": ""}).status_code == 422


def test_spoofed_forwarded_for_does_not_bypass_login_protection():
    """Подмена X-Forwarded-For не помогает перебору: адрес клиента берётся из соединения, а не из заголовка."""
    http = httpx.Client(base_url=API, timeout=30)
    login = f"spoof-{uuid.uuid4().hex[:6]}"
    statuses = [
        http.post(
            "/api/auth/login",
            json={"login": login, "password": "wrong"},
            headers={"X-Forwarded-For": f"203.0.113.{attempt}"},
        ).status_code
        for attempt in range(1, 8)
    ]
    assert 429 in statuses and statuses.index(429) <= 5, statuses


def test_uploaded_file_type_is_taken_from_extension():
    """Файл «.pdf» с заявленным типом text/html хранится и отдаётся как PDF: страницей нашего сайта он не откроется."""
    client = Client("veter")
    draft = client.post(
        "/api/applications",
        expect=201,
        json={"product_code": "GROWTH", "purpose": "EXPANSION", "amount": 2_000_000, "term_months": 24},
    )
    document = client.post(
        f"/api/applications/{draft['id']}/documents",
        expect=201,
        files={"file": ("x.pdf", b"<script>alert(1)</script>", "text/html")},
        data={"kind": "OTHER"},
    )
    assert document["content_type"] == "application/pdf"
    response = client.http.get(f"/api/documents/{document['id']}/download")
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert client.http.delete(f"/api/applications/{draft['id']}").status_code == 204


def test_security_headers_on_interface_and_api():
    """Интерфейс отдаётся с CSP и запретом встраивания, API — с nosniff; версия nginx не раскрывается."""
    http = httpx.Client(base_url=API, timeout=30)
    page = http.get("/")
    if "text/html" not in page.headers.get("content-type", ""):
        pytest.skip("тест проверяет nginx стенда, а API_URL указывает прямо на API")
    csp = page.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp
    assert page.headers["x-frame-options"] == "DENY"
    assert page.headers["server"] == "nginx"
    asset = next(part.split('"')[0] for part in page.text.split('src="')[1:] if part.startswith("/assets/"))
    script = http.get(asset)
    assert script.headers["x-content-type-options"] == "nosniff" and "content-security-policy" in script.headers
    api = http.get("/api/health")
    assert api.headers["x-content-type-options"] == "nosniff" and "content-security-policy" not in api.headers


def test_demo_reset_assigns_starting_applications_in_number_order():
    """Стартовые заявки сброса распределены тем же правилом по порядку номеров: стенд после сброса всегда одинаковый.
    Сценарий последний: сброс удаляет заявки, которые создали остальные."""
    analyst, analyst2 = Client("analyst"), Client("analyst2")
    Client("admin").post("/api/admin/demo/reset")
    deadline = time.monotonic() + 60
    while True:
        rows = analyst.get("/api/bank/applications")
        if len(rows) == 2 and all(r["status"] == "MANUAL_REVIEW" for r in rows):
            break
        assert time.monotonic() < deadline, "стартовые заявки не дошли до ручного рассмотрения"
        time.sleep(0.5)
    owners = {r["company_name"]: r["assignee_name"] for r in rows}
    assert owners == {
        "ООО «Вектор Логистик»": analyst.user["full_name"],
        "ООО «Гранд Девелопмент»": analyst2.user["full_name"],
    }
    assert [r["priority"] for r in rows] == ["MEDIUM", "MEDIUM"]
    assert analyst.get("/api/bank/summary")["mine"] == 1 and analyst2.get("/api/bank/summary")["mine"] == 1
