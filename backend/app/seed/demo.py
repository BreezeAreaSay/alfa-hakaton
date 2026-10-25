"""Демо-данные: продукты, компании, пользователи и заявки, которые сразу ждут аналитика."""

import logging
import shutil
import time
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import is_deadlock
from app.domain.catalog import PRODUCTS
from app.domain.enums import Actor, AppStatus, ConsentType, Purpose, Role
from app.domain.review import pick_analyst
from app.integrations.simulator import external_systems
from app.models import Application, Company, Consent, Product, User
from app.security import hash_password
from app.services.workflow import analyst_loads, assign_automatically, transition

log = logging.getLogger("seed")

DEMO_PASSWORD = "admin"

COMPANIES = [
    # ИНН, название, логин, ФИО, должность, право подписи
    ("0010000017", "ООО «Северный ветер»", "veter", "Ветров Андрей Сергеевич", "Генеральный директор", True),
    (
        "001000000436",
        "ИП Смирнова Анна Викторовна",
        "smirnova",
        "Смирнова Анна Викторовна",
        "Индивидуальный предприниматель",
        True,
    ),
    ("0010000024", "ООО «ТехноМастер»", "tehnomaster", "Кузнецов Игорь Петрович", "Генеральный директор", True),
    (
        "001000001006",
        "ИП Орлов Дмитрий Сергеевич",
        "orlov",
        "Орлов Дмитрий Сергеевич",
        "Индивидуальный предприниматель",
        True,
    ),
    (
        "0010000031",
        "ООО «Вектор Логистик»",
        "vektor",
        "Лебедева Марина Олеговна",
        "Финансовый директор (по доверенности)",
        True,
    ),
    ("0010000056", "ООО «Ромашка-Строй»", "romashka", "Петров Олег Николаевич", "Генеральный директор", True),
    ("0010000063", "ООО «Гранд Девелопмент»", "grand", "Соколов Виктор Андреевич", "Генеральный директор", True),
    ("0010000070", "ООО «Новый старт»", "start", "Морозова Екатерина Ильинична", "Генеральный директор", True),
    ("0010000088", "ООО «Альтаир»", "altair", "Белов Кирилл Андреевич", "Генеральный директор", True),
    ("0010000095", "ООО «Меридиан»", "meridian", "Новиков Сергей Павлович", "Генеральный директор", True),
]

STAFF = [
    ("analyst", "Иванова Ольга Дмитриевна", "Кредитный аналитик", Role.UNDERWRITER),
    ("analyst2", "Ковалёв Павел Игоревич", "Кредитный аналитик", Role.UNDERWRITER),
    ("admin", "Администратор демо-стенда", "Администратор", Role.ADMIN),
]

# Заявки, которые после сброса сразу уходят в конвейер и попадают в очередь аналитика.
PRESEED = [
    {
        "login": "vektor",
        "product_code": "GROWTH",
        "purpose": Purpose.EXPANSION,
        "purpose_text": "Покупка двух грузовых автомобилей и расширение автопарка",
        "amount": Decimal("12000000"),
        "term_months": 36,
        "declared_revenue": Decimal("36000000"),
    },
    {
        "login": "grand",
        "product_code": "SECURED",
        "purpose": Purpose.EXPANSION,
        "purpose_text": "Строительство складского комплекса",
        "amount": Decimal("60000000"),
        "term_months": 84,
        "declared_revenue": Decimal("420000000"),
        "collateral_type": "Коммерческая недвижимость",
        "collateral_value": Decimal("120000000"),
    },
]


def seed_reference(db: Session) -> None:
    for spec in PRODUCTS:
        product = db.get(Product, spec.code) or Product(code=spec.code)
        product.name = spec.name
        product.kind = spec.kind
        product.description = spec.description
        product.min_amount = spec.min_amount
        product.max_amount = spec.max_amount
        product.min_term = spec.min_term
        product.max_term = spec.max_term
        product.base_rate = spec.base_rate
        product.collateral_required = spec.collateral_required
        product.min_business_months = spec.min_business_months
        product.max_business_months = spec.max_business_months
        product.requires_bank_account_months = spec.requires_bank_account_months
        product.auto_limit = spec.auto_limit
        product.always_manual = spec.always_manual
        product.purposes = list(spec.purposes)
        product.sort_order = spec.sort_order
        product.active = True
        db.merge(product)
    db.flush()

    password = hash_password(DEMO_PASSWORD)
    for inn, name, login, full_name, position, can_sign in COMPANIES:
        company = db.scalars(select(Company).where(Company.inn == inn)).first()
        if company is None:
            company = Company(inn=inn, name=name)
            db.add(company)
            db.flush()
        user = db.scalars(select(User).where(User.login == login)).first()
        if user is None:
            db.add(
                User(
                    login=login,
                    password_hash=password,
                    full_name=full_name,
                    position=position,
                    role=Role.CLIENT,
                    company_id=company.id,
                    can_sign=can_sign,
                )
            )
    for login, full_name, position, role in STAFF:
        if db.scalars(select(User).where(User.login == login)).first() is None:
            db.add(User(login=login, password_hash=password, full_name=full_name, position=position, role=role))
    db.flush()


def sync_companies(db: Session) -> None:
    """Подтягивает профили компаний из ЕГРЮЛ/ЕГРИП симулятора. Если он недоступен — пропускаем."""
    from app.api.catalog import refresh_company

    for company in db.scalars(select(Company)):
        refresh_company(db, company)


def preseed(db: Session) -> int:
    from app.api.applications import next_number

    # Стартовые заявки распределяются сразу, тем же правилом и по порядку номеров, будто пришли на рассмотрение
    # одна за другой. Конвейер ведёт их параллельно, и иначе исполнитель зависел бы от того, какая первой
    # дойдёт до ручного рассмотрения, — стенд после сброса был бы каждый раз разным (docs/process.md)
    loads = analyst_loads(db) if get_settings().auto_assign else None
    created = 0
    for spec in PRESEED:
        user = db.scalars(select(User).where(User.login == spec["login"])).one()
        data = {k: v for k, v in spec.items() if k != "login"}
        application = Application(
            number=next_number(db),
            company_id=user.company_id,
            created_by=user.id,
            contact_name=user.full_name,
            status=AppStatus.DRAFT,
            **data,
        )
        db.add(application)
        db.flush()
        for kind in (ConsentType.BKI, ConsentType.PD):
            db.add(Consent(application_id=application.id, kind=kind, given_by=user.id, text_version="2026-10"))
        transition(db, application, AppStatus.SUBMITTED, actor=Actor.CLIENT, user=user)
        login = pick_analyst(loads) if loads is not None else None
        if login is not None:
            assign_automatically(db, application, login)
            loads[login] += 1
        created += 1
    return created


# Заявки (вместе с ними по CASCADE — документы, чат, события) и чаты с поддержкой
DEMO_DATA_TABLES = "applications, support_messages"


RESET_ATTEMPTS = 3
RESET_PAUSE_SECONDS = 0.2


def reset_demo(db: Session) -> int:
    """Сбросить демо-данные; при взаимной блокировке с обработчиком заявок — повторить.

    TRUNCATE берёт исключительные блокировки таблиц по одной: сначала заявки, затем каскадом задания конвейера.
    Обработчик, выбирая задание, блокирует задания и читает заявки — в обратном порядке, и Postgres прерывает одну
    из транзакций. Сброс идёт в точке сохранения: при откате она снимает свои
    блокировки, обработчик дописывает свою транзакцию, и повтор проходит. Работа, сделанная в той же транзакции
    до сброса (справочники при запуске seed), не теряется.
    """
    for attempt in range(1, RESET_ATTEMPTS + 1):
        try:
            with db.begin_nested():
                return _reset_once(db)
        except OperationalError as exc:
            if attempt == RESET_ATTEMPTS or not is_deadlock(exc):
                raise
            log.warning("Сброс демо-данных: взаимная блокировка с обработчиком заявок, повтор %s", attempt + 1)
            time.sleep(RESET_PAUSE_SECONDS * attempt)
    raise AssertionError("недостижимо: последняя попытка либо возвращает результат, либо поднимает ошибку")


def _reset_once(db: Session) -> int:
    # Идентификаторы не начинаются заново: открытые вкладки продолжают поток событий с последнего Last-Event-ID
    db.execute(text(f"TRUNCATE {DEMO_DATA_TABLES}, audit_log, idempotency_keys CASCADE"))
    db.execute(text("ALTER SEQUENCE application_number_seq RESTART WITH 1"))
    db.execute(text("UPDATE users SET last_read_event_id = 0"))
    files = Path(get_settings().files_dir)
    if files.exists():
        for child in files.iterdir():
            shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
    try:
        external_systems().reset_faults()
    except Exception:
        log.warning("Симулятор недоступен — сбои не сброшены")
    return preseed(db)
