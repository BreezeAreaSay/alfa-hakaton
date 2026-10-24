"""Конструктор тестовой компании: регистрация во внешних системах симулятора и учётная запись клиента.

Администратор задаёт компактное описание (schemas.CompanyBuilderIn), симулятор создаёт по нему данные ЕГРЮЛ,
ФНС, ГИР БО, БКИ и банка (simulator/sim/companies.py), а здесь появляются компания и пользователь-руководитель
с правом подписи — как у тестовых компаний из seed/demo.py. Исход заявки дальше считает конвейер.
"""

import re
from collections.abc import Collection
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import Role
from app.domain.features import industry_margin, industry_risk
from app.integrations.simulator import external_systems
from app.models import Company, User
from app.schemas import COMPANY_BUILDER_OKVED, CompanyBuilderIn, OkvedOption
from app.security import hash_password
from app.seed.demo import DEMO_PASSWORD

LOGIN_FALLBACK = "company"
LOGIN_MAX_LENGTH = 24

# Транслитерация для логина: латиница без диакритики, как у логинов тестовых компаний (tehnomaster, altair).
TRANSLIT: dict[str, str] = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i",
    "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "",
    "э": "e", "ю": "yu", "я": "ya",
}  # fmt: skip


class CompanyBuilderError(Exception):
    """Компанию создать нельзя: например, симулятор выдал ИНН, который уже есть в базе."""


def okved_options() -> list[OkvedOption]:
    return [
        OkvedOption(
            code=code, name=name, industry_risk=industry_risk(code), typical_margin=float(industry_margin(code))
        )
        for code, name in sorted(COMPANY_BUILDER_OKVED.items())
    ]


def login_base(name: str, legal_form: str) -> str:
    """Логин из названия: для ИП — фамилия, для ООО — слова названия подряд; только латиница и цифры."""
    words = name.split()
    source = words[0] if legal_form == "IP" and words else " ".join(words)
    latin = "".join(TRANSLIT.get(ch, ch) for ch in source.lower())
    latin = re.sub(r"[^a-z0-9]", "", latin)
    return (latin or LOGIN_FALLBACK)[:LOGIN_MAX_LENGTH]


def unique_login(base: str, taken: Collection[str]) -> str:
    """Свободный логин: при совпадении добавляется номер — start, start2, start3."""
    login, counter = base, 2
    while login in taken:
        login = f"{base}{counter}"
        counter += 1
    return login


def apply_registry(company: Company, egrul: dict[str, Any], bank: dict[str, Any]) -> None:
    """Заполняет профиль из ответов ЕГРЮЛ и банка — те же поля, что обновляет шаг конвейера."""
    company.name = egrul["name"]
    company.legal_form = egrul["legal_form"]
    company.ogrn = egrul["ogrn"]
    company.registration_date = date.fromisoformat(egrul["registration_date"])
    company.okved = egrul["okved"]
    company.okved_name = egrul["okved_name"]
    company.address = egrul["address"]
    company.status = egrul["status"]
    company.director_name = egrul["director"]["name"]
    company.is_bank_client = bool(bank.get("is_client"))
    opened = bank.get("account_opened_at")
    company.bank_account_opened_at = date.fromisoformat(opened) if opened else None
    company.registry_synced_at = datetime.now(UTC)


def create_test_company(db: Session, body: CompanyBuilderIn) -> tuple[Company, User]:
    """Регистрирует компанию в симуляторе и создаёт её вместе с пользователем-руководителем. Без commit."""
    registered = external_systems().register_company(
        {**body.model_dump(), "okved_name": COMPANY_BUILDER_OKVED[body.okved]}
    )
    inn: str = registered["inn"]
    if db.scalars(select(Company).where(Company.inn == inn)).first() is not None:
        raise CompanyBuilderError(f"Компания с ИНН {inn} уже есть в базе — повторите создание")
    egrul, bank = registered["egrul"], registered["bank"]
    company = Company(inn=inn, name=egrul["name"])
    apply_registry(company, egrul, bank)
    db.add(company)
    db.flush()

    taken = set(db.scalars(select(User.login)))
    user = User(
        login=unique_login(login_base(body.name, body.legal_form), taken),
        password_hash=hash_password(DEMO_PASSWORD),
        full_name=egrul["director"]["name"],
        position="Индивидуальный предприниматель" if body.legal_form == "IP" else "Генеральный директор",
        role=Role.CLIENT,
        company_id=company.id,
        can_sign=True,
    )
    db.add(user)
    db.flush()
    return company, user
