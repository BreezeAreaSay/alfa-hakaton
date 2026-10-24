import time
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.domain.catalog import KEY_RATE, ProductTerms, products_for_purpose
from app.domain.enums import Role
from app.domain.features import build_features
from app.domain.labels import (
    COMPANY_STATUS_LABELS,
    DOCUMENT_LABELS,
    INFO_ITEM_PRESETS,
    PURPOSE_LABELS,
    STATUS_LABELS,
    STEP_LABELS,
)
from app.domain.policy import (
    ADVICE,
    CHEAPER_WHY,
    FACTOR_ADVICE,
    FLAGS,
    LIMIT_PHRASES,
    REASONS,
    STOP_FACTORS,
    eligibility_issues,
    offer_figures,
)
from app.domain.proactive import TYPICAL_TERM, proactive_facts, proactive_note, proactive_offers
from app.integrations.simulator import SourceNotFound, SourceUnavailable, external_systems
from app.models import Company, Product, User
from app.schemas import CompanyOut, ProactiveOffer, ProactiveOffers, ProductOut, QuoteItem, QuoteRequest
from app.security import require_roles
from app.services.views import company_out, payment_label

router = APIRouter(prefix="/api", tags=["Каталог и справочники"])
service = APIRouter(prefix="/api", tags=["Служебное"])


@router.get("/meta", summary="Справочники: статусы, цели, документы, коды причин")
def meta() -> dict:
    return {
        "statuses": STATUS_LABELS,
        "steps": STEP_LABELS,
        "purposes": PURPOSE_LABELS,
        "documents": DOCUMENT_LABELS,
        "company_statuses": COMPANY_STATUS_LABELS,
        "info_items": INFO_ITEM_PRESETS,
        "reasons": {code: {"bank": bank, "client": client} for code, (bank, client) in REASONS.items()},
        "flags": FLAGS,
        "stop_factors": STOP_FACTORS,
        "limit_phrases": LIMIT_PHRASES,
        "advice": ADVICE,
        "cheaper_why": CHEAPER_WHY,
        "factor_advice": FACTOR_ADVICE,
        "key_rate": float(KEY_RATE),
    }


@router.get("/products", response_model=list[ProductOut], summary="Каталог кредитных продуктов")
def products(db: Session = Depends(get_db)) -> list[Product]:
    return list(db.scalars(select(Product).where(Product.active).order_by(Product.sort_order)))


@router.post("/calculator/quote", response_model=list[QuoteItem], summary="Подбор продуктов под задачу и расчёт")
def quote(body: QuoteRequest, db: Session = Depends(get_db)) -> list[QuoteItem]:
    catalog = {p.code: p for p in db.scalars(select(Product).where(Product.active))}
    items = []
    for code in products_for_purpose(body.purpose, body.business_months):
        model = catalog.get(code)
        if model is None:
            continue
        product = ProductTerms.from_model(model)
        issues = eligibility_issues(
            product,
            business_months=body.business_months,
            is_bank_client=body.is_bank_client,
            account_months=body.account_months,
            amount=body.amount,
            term_months=body.term_months,
        )
        amount = min(max(body.amount, product.min_amount), product.max_amount)
        term = min(max(body.term_months, product.min_term), product.max_term)
        monthly, over = offer_figures(product, Decimal(amount), product.base_rate, term)
        items.append(
            QuoteItem(
                product=ProductOut.model_validate(model),
                eligible=not issues,
                issues=[i.text for i in issues],
                rate_from=product.base_rate,
                monthly_payment=monthly,
                overpayment=over,
                payment_label=payment_label(product.kind),
            )
        )
    # Подходящие продукты — от меньшей ставки к большей: для предпринимателя главный критерий выбора — стоимость
    # (docs/research/interviews/01.md). Недоступные — после них, в порядке уместности для задачи.
    return [
        item
        for _, item in sorted(
            enumerate(items),
            key=lambda pair: (not pair[1].eligible, pair[1].rate_from if pair[1].eligible else 0, pair[0]),
        )
    ]


PROACTIVE_TTL_SECONDS = 600
_proactive_cache: dict[uuid.UUID, tuple[float, ProactiveOffers]] = {}


@router.get("/offers/proactive", response_model=ProactiveOffers, summary="Предварительные предложения клиенту")
def proactive(user: User = Depends(require_roles(Role.CLIENT)), db: Session = Depends(get_db)) -> ProactiveOffers:
    """Что банк готов дать по ЕГРЮЛ/ЕГРИП, отчётности и оборотам — без кредитной истории и заявки. Кеш 10 минут."""
    company = user.company
    cached = _proactive_cache.get(company.id)
    if cached and time.monotonic() - cached[0] < PROACTIVE_TTL_SECONDS:
        return cached[1]
    computed_at = datetime.now(UTC)
    systems = external_systems()
    try:
        # Признаки ждут результат шага конвейера: ответ реестра с пометкой found
        egrul = {"found": True, **systems.egrul(company.inn)}
        bank = systems.bank(company.inn)
        girbo = systems.girbo(company.inn) if egrul.get("legal_form") == "OOO" else None
    except (SourceUnavailable, SourceNotFound):
        return ProactiveOffers(
            offers=[], facts=[], note="Внешние источники сейчас недоступны — попробуйте позже", computed_at=computed_at
        )
    features = build_features(
        today=computed_at.date(),
        amount=Decimal(0),
        term_months=TYPICAL_TERM,
        declared_revenue=None,
        egrul=egrul,
        fns=None,
        girbo=girbo,
        bki=None,
        bank=bank,
        statement=None,
    )
    catalog = {p.code: ProductTerms.from_model(p) for p in db.scalars(select(Product).where(Product.active))}
    offers = proactive_offers(catalog, features)
    result = ProactiveOffers(
        offers=[ProactiveOffer(**offer, payment_label=payment_label(offer["kind"])) for offer in offers],
        facts=proactive_facts(features),
        note=proactive_note(features, offers),
        computed_at=computed_at,
    )
    _proactive_cache[company.id] = (time.monotonic(), result)
    return result


def refresh_company(db: Session, company: Company) -> None:
    """Подтягивает данные из ЕГРЮЛ/ЕГРИП и сведения о счёте. Если источник недоступен — остаются прежние."""
    systems = external_systems()
    try:
        data = systems.egrul(company.inn)
        company.name = data["name"]
        company.legal_form = data["legal_form"]
        company.ogrn = data["ogrn"]
        company.registration_date = date.fromisoformat(data["registration_date"])
        company.okved = data["okved"]
        company.okved_name = data["okved_name"]
        company.address = data["address"]
        company.status = data["status"]
        company.director_name = data["director"]["name"]
        bank = systems.bank(company.inn)
        company.is_bank_client = bool(bank.get("is_client"))
        opened = bank.get("account_opened_at")
        company.bank_account_opened_at = date.fromisoformat(opened) if opened else None
        company.registry_synced_at = datetime.now(UTC)
    except (SourceUnavailable, SourceNotFound):
        return


@router.get("/company", response_model=CompanyOut, summary="Профиль компании клиента (из ЕГРЮЛ / ЕГРИП)")
def my_company(
    refresh: bool = False, user: User = Depends(require_roles(Role.CLIENT)), db: Session = Depends(get_db)
) -> CompanyOut:
    company = db.get(Company, user.company_id)
    stale = company.registry_synced_at is None or company.registry_synced_at < datetime.now(UTC) - timedelta(days=1)
    if refresh or stale:
        refresh_company(db, company)
        db.commit()
    return company_out(company)


@service.get("/health", summary="Проверка, что сервис жив")
def health() -> dict[str, str]:
    return {"status": "ok"}


@service.get("/ready", summary="Проверка готовности: база данных доступна")
def ready(db: Session = Depends(get_db)) -> dict[str, str]:
    db.execute(select(1))
    return {"status": "ready"}
