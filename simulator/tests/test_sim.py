import os

os.environ["SIMULATOR_LATENCY_SCALE"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

from sim.main import app  # noqa: E402

client = TestClient(app)


def test_egrul_returns_dates_relative_to_today():
    data = client.get("/egrul/0010000017").json()
    assert data["name"] == "ООО «Северный ветер»"
    assert data["legal_form"] == "OOO"
    assert data["registration_date"] <= data["director"]["since"]


def test_unknown_inn_is_not_found():
    assert client.get("/egrul/0000000000").status_code == 404


def test_girbo_is_unavailable_for_individual_entrepreneur():
    assert client.get("/girbo/001000000436").json()["available"] is False


def test_bki_requires_consent():
    assert client.post("/bki/report", json={"inn": "0010000017", "consent_id": ""}).status_code == 400
    report = client.post("/bki/report", json={"inn": "0010000017", "consent_id": "c-1"}).json()
    assert report["loans"][0]["monthly_payment"] == 150000


def test_bank_client_has_twelve_months_of_inflows():
    data = client.get("/bank/clients/001000000436").json()
    assert data["is_client"] is True
    assert len(data["months"]) == 12
    assert data["months"][0]["month"] < data["months"][-1]["month"]


def test_fault_injection_and_reset():
    client.put("/admin/faults/bki", json={"mode": "error"})
    assert client.post("/bki/report", json={"inn": "0010000017", "consent_id": "c"}).status_code == 503
    client.post("/admin/faults/reset")
    assert client.post("/bki/report", json={"inn": "0010000017", "consent_id": "c"}).status_code == 200


def test_disbursement_returns_account():
    data = client.post(
        "/core/loans",
        json={"inn": "0010000017", "application_number": "2026-00001", "amount": 1e6, "rate": 19, "term_months": 24},
    ).json()
    assert data["account_number"].startswith("45207810")
    assert len(data["account_number"]) == 20
