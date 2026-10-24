"""Администрирование демо-стенда: сброс данных, управление сбоями внешних систем, конструктор тестовой компании."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.domain.enums import Actor
from app.integrations.simulator import SourceUnavailable, external_systems
from app.models import AuditLog, User
from app.schemas import CompanyBuilderIn, CompanyBuilderOptions, CompanyBuilderOut, FaultIn
from app.security import admin_only, bank_staff
from app.seed.demo import DEMO_PASSWORD, reset_demo
from app.services import companies
from app.services.audit import audit
from app.services.login_limiter import login_limiter
from app.services.views import company_out

router = APIRouter(prefix="/api/admin", tags=["Администрирование демо"])

SOURCE_TITLES = {
    "egrul": "ЕГРЮЛ / ЕГРИП",
    "fns": "ФНС «Прозрачный бизнес»",
    "girbo": "ГИР БО (отчётность)",
    "bki": "Бюро кредитных историй",
    "bank": "Внутренние данные банка",
    "core": "Выдача кредита (АБС)",
}


@router.post("/demo/reset", summary="Сбросить демо-данные: удалить заявки и вернуть исходное состояние")
def reset(user: User = Depends(admin_only), db: Session = Depends(get_db)) -> dict:
    created = reset_demo(db)
    login_limiter().clear()  # вместе с данными снимаются и блокировки входа
    audit(db, actor=Actor.ADMIN, user=user, action="DEMO_RESET", entity_type="system", entity_id="demo")
    db.commit()
    return {"status": "ok", "preseeded": created}


@router.get("/simulator/faults", summary="Состояние внешних систем в симуляторе")
def faults(user: User = Depends(bank_staff)) -> list[dict]:
    state = external_systems().faults()
    return [{"source": key, "title": SOURCE_TITLES[key], **value} for key, value in state.items()]


@router.put("/simulator/faults/{source}", summary="Включить или выключить сбой внешней системы")
def set_fault(
    source: str, body: FaultIn, user: User = Depends(admin_only), db: Session = Depends(get_db)
) -> list[dict]:
    if source not in SOURCE_TITLES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Неизвестная внешняя система: {source}")
    external_systems().set_fault(source, body.mode, body.latency_ms)
    audit(
        db,
        actor=Actor.ADMIN,
        user=user,
        action="FAULT_SET",
        entity_type="simulator",
        entity_id=source,
        details={"mode": body.mode, "latency_ms": body.latency_ms},
    )
    db.commit()
    return faults(user)


@router.post("/simulator/faults/reset", summary="Вернуть все внешние системы в рабочее состояние")
def reset_faults(user: User = Depends(admin_only), db: Session = Depends(get_db)) -> list[dict]:
    external_systems().reset_faults()
    audit(db, actor=Actor.ADMIN, user=user, action="FAULTS_RESET", entity_type="simulator", entity_id="all")
    db.commit()
    return faults(user)


@router.get(
    "/companies/options",
    response_model=CompanyBuilderOptions,
    summary="Справочники для конструктора тестовой компании",
)
def company_options(user: User = Depends(bank_staff)) -> CompanyBuilderOptions:
    return CompanyBuilderOptions(okved=companies.okved_options())


@router.post(
    "/companies",
    response_model=CompanyBuilderOut,
    status_code=201,
    summary="Создать свою тестовую компанию: данные во всех внешних системах и учётная запись клиента",
)
def create_company(
    body: CompanyBuilderIn, user: User = Depends(admin_only), db: Session = Depends(get_db)
) -> CompanyBuilderOut:
    """Исход заявки заранее не задаётся: его считает конвейер по общим правилам скоринга и кредитной политики.
    Сброс демо-данных созданные компании не удаляет."""
    try:
        company, client = companies.create_test_company(db, body)
    except SourceUnavailable as error:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, f"Симулятор внешних систем недоступен, компания не создана: {error}"
        ) from None
    except companies.CompanyBuilderError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from None
    audit(
        db,
        actor=Actor.ADMIN,
        user=user,
        action="COMPANY_CREATED",
        entity_type="company",
        entity_id=company.id,
        details={"inn": company.inn, "name": company.name, "login": client.login},
    )
    db.commit()
    return CompanyBuilderOut(login=client.login, password=DEMO_PASSWORD, company=company_out(company), inn=company.inn)


@router.get("/audit", summary="Журнал действий")
def audit_log(user: User = Depends(bank_staff), db: Session = Depends(get_db)) -> list[dict]:
    rows = db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(200)).all()
    users = {u.id: u.full_name for u in db.scalars(select(User))}
    return [
        {
            "id": r.id,
            "action": r.action,
            "actor": r.actor,
            "user": users.get(r.actor_user_id),
            "entity_type": r.entity_type,
            "entity_id": r.entity_id,
            "details": r.details,
            "created_at": r.created_at,
        }
        for r in rows
    ]
