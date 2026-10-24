"""Конструктор персон: по компактному описанию компании симулятор создаёт её данные во всех внешних системах —
ЕГРЮЛ/ЕГРИП, ФНС, ГИР БО, БКИ и банк — по тем же правилам, что у персон из companies.json.

Генерация детерминирована: одно и то же описание всегда даёт одни и те же данные, а имитация API в демо-версии
интерфейса (frontend/src/demo/engine/company-builder.ts) повторяет её один в один. Созданные персоны живут
в памяти вместе с остальными и дописываются в файл (SIMULATOR_CUSTOM_FILE), чтобы пережить перезапуск.
"""

import json
import logging
import math
import os
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

log = logging.getLogger("sim")

PERSONA = "Своя компания: создана в конструкторе администратора"
# Код налогового органа 00 не существует, поэтому совпадение с реальными компаниями исключено;
# у персон из companies.json — 0010, у созданных — 0020.
INN_PREFIX = "0020"
REGION = "77"
LENDER = "Банк «Восток»"

# Поступления на счёт по месяцам: небольшой разброс вокруг среднего, сумма коэффициентов — ровно 12.
# Для каждой компании ряд сдвигается по кругу, чтобы графики не были одинаковыми.
INFLOW_PATTERN = (0.97, 1.02, 0.95, 1.04, 1.0, 0.98, 1.03, 0.99, 1.01, 1.05, 0.96, 1.0)

DIRECTORS = (
    "Крылова Наталья Сергеевна",
    "Фёдоров Максим Андреевич",
    "Зайцева Елена Владимировна",
    "Волков Дмитрий Олегович",
    "Тихонова Ирина Павловна",
    "Романов Алексей Викторович",
    "Мельникова Ольга Игоревна",
    "Егоров Павел Николаевич",
)

STREETS = (
    "ул. Берёзовая",
    "Садовый проезд",
    "ул. Речная",
    "Кленовый бульвар",
    "ул. Заводская",
    "Парковая ул.",
    "ул. Полевая",
    "Солнечный переулок",
)


class CompanySpec(BaseModel):
    """Компактное описание компании. Проверки — страховка: бэкенд проверяет параметры подробнее и по-русски."""

    name: str = Field(min_length=1, max_length=120)
    legal_form: Literal["OOO", "IP"]
    registered_months_ago: int = Field(ge=0, le=600)
    okved: str = Field(min_length=2, max_length=8)
    okved_name: str = Field(min_length=1, max_length=255)
    revenue: int = Field(gt=0)
    revenue_growth: float = Field(ge=-0.9, le=10)
    margin: float = Field(ge=-1, le=1)
    existing_monthly_payments: int = Field(ge=0)
    max_overdue_days_24m: int = Field(ge=0)
    current_overdue_days: int = Field(ge=0)
    tax_debt: int = Field(ge=0)
    mass_address: bool
    director_disqualified: bool
    company_status: Literal["ACTIVE", "LIQUIDATING"]
    is_bank_client: bool
    account_months: int = Field(ge=0)
    avg_monthly_inflow: int = Field(ge=0)


def half_up(value: float) -> int:
    """Округление половиной вверх: одинаково в Python и JavaScript (round() в Python округляет к чётному)."""
    return math.floor(value + 0.5)


def text_hash(text: str) -> int:
    """Простая сумма кодов символов — чтобы одинаково выбирать руководителя и адрес здесь и в демо-версии."""
    return sum(ord(ch) for ch in text)


def _checksum(digits: list[int], weights: tuple[int, ...]) -> int:
    return sum(d * w for d, w in zip(digits, weights, strict=False)) % 11 % 10


def make_inn(serial: int, legal_form: str) -> str:
    """ИНН с верными контрольными цифрами: 10 знаков для ООО, 12 для ИП (как backend/app/services/inn.py)."""
    if legal_form == "OOO":
        body = f"{INN_PREFIX}{serial:05d}"
        digits = [int(c) for c in body]
        return body + str(_checksum(digits, (2, 4, 10, 3, 5, 9, 4, 6, 8)))
    body = f"{INN_PREFIX}{serial:06d}"
    digits = [int(c) for c in body]
    n11 = _checksum(digits, (7, 2, 4, 10, 3, 5, 9, 4, 6, 8))
    n12 = _checksum([*digits, n11], (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8))
    return f"{body}{n11}{n12}"


def make_ogrn(serial: int, legal_form: str) -> str:
    """ОГРН (13 знаков, контроль по модулю 11) или ОГРНИП (15 знаков, по модулю 13)."""
    if legal_form == "OOO":
        body = f"100{REGION}{serial:07d}"
        return body + str(int(body) % 11 % 10)
    body = f"310{REGION}{serial:09d}"
    return body + str(int(body) % 13 % 10)


def _report_year(offset: int, revenue: int, margin: float) -> dict[str, Any]:
    sales_profit = half_up(revenue * margin)
    net_profit = half_up(sales_profit * (0.75 if sales_profit >= 0 else 1.25))
    return {"year_offset": offset, "revenue": revenue, "sales_profit": sales_profit, "net_profit": net_profit}


def _reports(spec: CompanySpec) -> dict[str, Any] | None:
    """Отчётность ГИР БО: только у ООО, за полный год — после года работы, за два — после двух."""
    if spec.legal_form != "OOO" or spec.registered_months_ago < 12:
        return None
    years = [_report_year(1, spec.revenue, spec.margin)]
    if spec.registered_months_ago >= 24:
        years.append(_report_year(2, half_up(spec.revenue / (1 + spec.revenue_growth)), spec.margin))
    return {"years": years}


def _credit_history(spec: CompanySpec) -> dict[str, Any]:
    payments = spec.existing_monthly_payments
    loans = []
    if payments > 0:
        loans.append(
            {
                "lender": LENDER,
                "kind": "Кредит",
                "amount": payments * 36,
                "balance": payments * 20,
                "monthly_payment": payments,
                "opened_months_ago": min(16, spec.registered_months_ago),
            }
        )
    return {
        "has_history": payments > 0 or spec.max_overdue_days_24m > 0 or spec.current_overdue_days > 0,
        "max_overdue_days_24m": max(spec.max_overdue_days_24m, spec.current_overdue_days),
        "current_overdue_days": spec.current_overdue_days,
        "loans": loans,
    }


def _bank(spec: CompanySpec, shift: int) -> dict[str, Any]:
    if not spec.is_bank_client:
        return {"is_client": False}
    rotated = INFLOW_PATTERN[shift:] + INFLOW_PATTERN[:shift]
    months = min(spec.account_months, len(rotated))
    return {
        "is_client": True,
        "account_opened_months_ago": spec.account_months,
        "inflow_base": spec.avg_monthly_inflow,
        "inflow_pattern": list(rotated[len(rotated) - months :]),
    }


def build_persona(spec: CompanySpec, inn: str, ogrn: str, created_at: str) -> dict[str, Any]:
    """Данные всех источников в формате companies.json. Даты — в месяцах до текущего дня, как у остальных персон."""
    h = text_hash(spec.name)
    is_ip = spec.legal_form == "IP"
    director = spec.name if is_ip else DIRECTORS[h % len(DIRECTORS)]
    address = f"г. Москва, {STREETS[h % len(STREETS)]}, д. {1 + h % 40}"
    if not is_ip:
        address += f", офис {1 + h % 90}"
    return {
        "persona": PERSONA,
        "custom": True,
        "created_at": created_at,
        "spec": spec.model_dump(),
        "egrul": {
            "name": f"ИП {spec.name}" if is_ip else f"ООО «{spec.name}»",
            "legal_form": spec.legal_form,
            "ogrn": ogrn,
            "registered_months_ago": spec.registered_months_ago,
            "status": spec.company_status,
            "okved": spec.okved,
            "okved_name": spec.okved_name,
            "address": address,
            "director": {"name": director, "since_months_ago": spec.registered_months_ago},
        },
        "fns": {
            "tax_debt": spec.tax_debt,
            "mass_address": spec.mass_address,
            "director_disqualified": spec.director_disqualified,
            "employees": min(500, max(1, half_up(spec.revenue / 3_000_000))),
            "tax_regime": "ОСН" if spec.revenue > 60_000_000 else "УСН",
        },
        "girbo": _reports(spec),
        "bki": _credit_history(spec),
        "bank": _bank(spec, h % len(INFLOW_PATTERN)),
    }


def custom_file() -> Path | None:
    """Файл с созданными персонами: SIMULATOR_CUSTOM_FILE; пустое значение — только память."""
    value = os.getenv("SIMULATOR_CUSTOM_FILE")
    if value is None:
        return Path(tempfile.gettempdir()) / "credit-simulator" / "custom_companies.json"
    return Path(value) if value else None


class CompanyStore:
    """Персоны симулятора: из companies.json и созданные через POST /companies."""

    def __init__(self, builtin: dict[str, Any], path: Path | None) -> None:
        self.data: dict[str, Any] = dict(builtin)
        self.path = path
        self._lock = threading.Lock()
        self.load()

    @property
    def custom(self) -> dict[str, Any]:
        return {inn: persona for inn, persona in self.data.items() if persona.get("custom")}

    def load(self) -> int:
        """Дочитывает созданные персоны из файла; персоны из companies.json не перекрываются."""
        if self.path is None or not self.path.exists():
            return 0
        try:
            stored = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            log.warning("Файл созданных компаний %s не прочитан: %s", self.path, error)
            return 0
        added = 0
        for inn, persona in stored.get("companies", {}).items():
            if inn not in self.data:
                self.data[inn] = persona
                added += 1
        return added

    def save(self) -> None:
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            draft = self.path.with_suffix(".tmp")
            draft.write_text(json.dumps({"companies": self.custom}, ensure_ascii=False, indent=2), encoding="utf-8")
            draft.replace(self.path)
        except OSError as error:
            log.warning(
                "Созданные компании не сохранены в %s (%s): они живут до перезапуска симулятора", self.path, error
            )

    def register(self, spec: CompanySpec) -> str:
        """Создаёт персону со следующим свободным ИНН, возвращает ИНН."""
        with self._lock:
            serial = len(self.custom) + 1
            while make_inn(serial, spec.legal_form) in self.data:
                serial += 1
            inn = make_inn(serial, spec.legal_form)
            created_at = datetime.now(UTC).isoformat()
            self.data[inn] = build_persona(spec, inn, make_ogrn(serial, spec.legal_form), created_at)
            self.save()
            return inn
