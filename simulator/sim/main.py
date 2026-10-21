"""Симулятор внешних систем: ЕГРЮЛ/ЕГРИП, ФНС, ГИР БО, БКИ, внутренние данные банка, выдача кредита.

Данные синтетические (app/data/companies.json). Контракты упрощены, смысл интеграций сохранён.
Через /admin/faults можно включить сбой любого источника, чтобы проверить устойчивость конвейера.
"""

import asyncio
import json
import os
import random
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

DATA = json.loads((Path(__file__).parent / "data" / "companies.json").read_text(encoding="utf-8"))["companies"]
SOURCES = ("egrul", "fns", "girbo", "bki", "bank", "core")

app = FastAPI(title="Симулятор внешних систем", version="1.0.0")


class Fault(BaseModel):
    mode: Literal["ok", "error", "timeout", "slow"] = "ok"
    latency_ms: int = 0


FAULTS: dict[str, Fault] = {source: Fault() for source in SOURCES}
BASE_LATENCY_MS = {"egrul": 300, "fns": 250, "girbo": 300, "bki": 600, "bank": 200, "core": 400}
LATENCY_SCALE = float(os.getenv("SIMULATOR_LATENCY_SCALE", "1"))


async def gate(source: str) -> None:
    """Задержка, похожая на реальный сервис, и включённый сбой."""
    fault = FAULTS[source]
    if fault.mode == "error":
        raise HTTPException(503, f"{source}: сервис временно недоступен")
    if fault.mode == "timeout":
        await asyncio.sleep(30)
    delay = BASE_LATENCY_MS[source] * LATENCY_SCALE + (fault.latency_ms if fault.mode == "slow" else 0)
    if delay:
        await asyncio.sleep(delay / 1000 * random.uniform(0.7, 1.3))


def months_ago(months: int, today: date | None = None) -> date:
    today = today or datetime.now(UTC).date()
    index = today.year * 12 + today.month - 1 - months
    year, month = divmod(index, 12)
    return date(year, month + 1, min(today.day, 28))


def company(inn: str) -> dict[str, Any]:
    data = DATA.get(inn)
    if data is None:
        raise HTTPException(404, "Компания с таким ИНН не найдена в реестре")
    return data


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/egrul/{inn}")
async def egrul(inn: str) -> dict[str, Any]:
    await gate("egrul")
    e = company(inn)["egrul"]
    return {
        "inn": inn,
        "name": e["name"],
        "legal_form": e["legal_form"],
        "ogrn": e["ogrn"],
        "registration_date": months_ago(e["registered_months_ago"]).isoformat(),
        "status": e["status"],
        "okved": e["okved"],
        "okved_name": e["okved_name"],
        "address": e["address"],
        "director": {
            "name": e["director"]["name"],
            "since": months_ago(e["director"]["since_months_ago"]).isoformat(),
        },
    }


@app.get("/fns/{inn}")
async def fns(inn: str) -> dict[str, Any]:
    await gate("fns")
    return {"inn": inn, **company(inn)["fns"]}


@app.get("/girbo/{inn}")
async def girbo(inn: str) -> dict[str, Any]:
    await gate("girbo")
    data = company(inn)
    report = data.get("girbo")
    if not report or data["egrul"]["legal_form"] != "OOO":
        return {"inn": inn, "available": False, "years": []}
    year = datetime.now(UTC).year
    years = [
        {
            "year": year - y["year_offset"],
            "revenue": y["revenue"],
            "sales_profit": y["sales_profit"],
            "net_profit": y["net_profit"],
        }
        for y in report["years"]
    ]
    return {"inn": inn, "available": True, "years": years}


class BkiRequest(BaseModel):
    inn: str
    consent_id: str


@app.post("/bki/report")
async def bki(request: BkiRequest) -> dict[str, Any]:
    await gate("bki")
    if not request.consent_id:
        raise HTTPException(400, "Нет согласия субъекта на запрос кредитной истории")
    b = company(request.inn)["bki"]
    loans = [
        {
            "lender": loan["lender"],
            "kind": loan["kind"],
            "amount": loan["amount"],
            "balance": loan["balance"],
            "monthly_payment": loan["monthly_payment"],
            "opened_at": months_ago(loan["opened_months_ago"]).isoformat(),
        }
        for loan in b["loans"]
    ]
    return {
        "inn": request.inn,
        "has_history": b["has_history"],
        "max_overdue_days_24m": b["max_overdue_days_24m"],
        "current_overdue_days": b["current_overdue_days"],
        "loans": loans,
    }


@app.get("/bank/clients/{inn}")
async def bank_client(inn: str) -> dict[str, Any]:
    await gate("bank")
    b = company(inn)["bank"]
    if not b.get("is_client"):
        return {"inn": inn, "is_client": False, "months": []}
    pattern = b["inflow_pattern"]
    today = datetime.now(UTC).date()
    months = []
    for i, k in enumerate(pattern):
        month = months_ago(len(pattern) - i, today)
        months.append({"month": month.strftime("%Y-%m"), "inflow": round(b["inflow_base"] * k, 2)})
    return {
        "inn": inn,
        "is_client": True,
        "account_opened_at": months_ago(b["account_opened_months_ago"], today).isoformat(),
        "months": months,
    }


class DisbursementRequest(BaseModel):
    inn: str
    application_number: str
    amount: float
    rate: float
    term_months: int


@app.post("/core/loans")
async def disburse(request: DisbursementRequest) -> dict[str, Any]:
    await gate("core")
    company(request.inn)
    digits = "".join(ch for ch in request.application_number if ch.isdigit())
    return {
        "account_number": f"45207810{digits[-12:].rjust(12, '0')}",
        "disbursed_at": datetime.now(UTC).isoformat(),
        "status": "DISBURSED",
    }


@app.get("/admin/faults")
def get_faults() -> dict[str, Fault]:
    return FAULTS


@app.put("/admin/faults/{source}")
def set_fault(source: str, fault: Fault) -> dict[str, Fault]:
    if source not in FAULTS:
        raise HTTPException(404, "Нет такого источника")
    FAULTS[source] = fault
    return FAULTS


@app.post("/admin/faults/reset")
def reset_faults() -> dict[str, Fault]:
    for source in SOURCES:
        FAULTS[source] = Fault()
    return FAULTS


@app.get("/admin/companies")
def companies() -> list[dict[str, str]]:
    return [{"inn": inn, "name": c["egrul"]["name"], "persona": c["persona"]} for inn, c in DATA.items()]
