"""Действия клиента с заявкой."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Response, UploadFile, status
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from app.db import get_db
from app.domain.catalog import ProductTerms
from app.domain.enums import (
    Actor,
    AppStatus,
    Audience,
    ConsentType,
    DocumentKind,
    DocumentSource,
    InfoOrigin,
    InfoStatus,
    OfferStatus,
    Role,
)
from app.domain.features import months_between
from app.domain.policy import eligibility_issues
from app.models import (
    Application,
    Company,
    Consent,
    Document,
    Event,
    InfoRequest,
    Message,
    Offer,
    Product,
    Signature,
    User,
)
from app.schemas import (
    ApplicationCreate,
    ApplicationListItem,
    ApplicationOut,
    ApplicationUpdate,
    DocumentOut,
    InfoAnswer,
    LoanOut,
    MessageIn,
    MessageOut,
    SignRequest,
    SubmitRequest,
)
from app.security import client_only, current_user, ensure_access, verify_password
from app.services import documents, events, idempotency
from app.services.audit import audit
from app.services.statements import StatementError, parse_statement
from app.services.views import application_out, documents_out, list_item, loan_out
from app.services.workflow import transition

router = APIRouter(prefix="/api", tags=["Заявки клиента"])

CONSENT_TEXT_VERSION = "2026-10"


def load(db: Session, application_id: uuid.UUID, user: User, lock: bool = False) -> Application:
    application = db.get(Application, application_id, with_for_update=lock)
    return ensure_access(user, application)


def get_product(db: Session, code: str) -> Product:
    product = db.get(Product, code)
    if product is None or not product.active:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Такого продукта нет")
    return product


def next_number(db: Session) -> str:
    value = db.execute(text("select nextval('application_number_seq')")).scalar_one()
    return f"{datetime.now(UTC).year}-{value:05d}"


def validate_terms(product: Product, company: Company, amount: Decimal, term: int) -> None:
    terms = ProductTerms.from_model(product)
    business_months = None
    account_months = 0
    if company.registration_date:
        today = datetime.now(UTC).date()
        business_months = months_between(company.registration_date, today)
        if company.bank_account_opened_at:
            account_months = months_between(company.bank_account_opened_at, today)
    issues = eligibility_issues(
        terms,
        business_months=business_months,
        is_bank_client=company.is_bank_client,
        account_months=account_months,
        amount=amount,
        term_months=term,
    )
    if issues:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "; ".join(i.text for i in issues))


@router.post("/applications", response_model=ApplicationOut, status_code=201, summary="Создать черновик заявки")
def create(body: ApplicationCreate, user: User = Depends(client_only), db: Session = Depends(get_db)) -> ApplicationOut:
    product = get_product(db, body.product_code)
    application = Application(
        number=next_number(db),
        company_id=user.company_id,
        created_by=user.id,
        product_code=product.code,
        purpose=body.purpose,
        purpose_text=body.purpose_text,
        amount=body.amount,
        term_months=body.term_months,
        declared_revenue=body.declared_revenue,
        collateral_type=body.collateral_type,
        collateral_value=body.collateral_value,
        contact_name=user.full_name,
        status=AppStatus.DRAFT,
        ai_parsed=body.ai_parsed,
    )
    db.add(application)
    db.flush()
    audit(
        db,
        actor=Actor.CLIENT,
        user=user,
        action="DRAFT_CREATED",
        entity_type="application",
        entity_id=application.id,
        details={"product": product.code, "amount": float(body.amount)},
    )
    db.commit()
    db.refresh(application)
    return application_out(db, application, user)


@router.get("/applications", response_model=list[ApplicationListItem], summary="Заявки моей компании")
def my_applications(user: User = Depends(client_only), db: Session = Depends(get_db)) -> list[ApplicationListItem]:
    rows = db.scalars(
        select(Application).where(Application.company_id == user.company_id).order_by(Application.created_at.desc())
    ).all()
    return [list_item(a) for a in rows]


@router.get("/applications/{application_id}", response_model=ApplicationOut, summary="Карточка заявки")
def get_application(
    application_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> ApplicationOut:
    return application_out(db, load(db, application_id, user), user)


@router.patch("/applications/{application_id}", response_model=ApplicationOut, summary="Изменить черновик")
def update(
    application_id: uuid.UUID,
    body: ApplicationUpdate,
    user: User = Depends(client_only),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    application = load(db, application_id, user, lock=True)
    if application.status != AppStatus.DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Изменить можно только черновик")
    changes = body.model_dump(exclude_unset=True)
    if "product_code" in changes:
        get_product(db, changes["product_code"])
    for field, value in changes.items():
        setattr(application, field, value)
    db.commit()
    return application_out(db, application, user)


@router.delete("/applications/{application_id}", status_code=204, summary="Удалить черновик")
def delete_draft(
    application_id: uuid.UUID, user: User = Depends(client_only), db: Session = Depends(get_db)
) -> Response:
    application = load(db, application_id, user, lock=True)
    if application.status != AppStatus.DRAFT:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Удалить можно только черновик. Отправленную заявку можно отозвать"
        )
    files = []
    for document in db.scalars(select(Document).where(Document.application_id == application.id)):
        files.append(document.storage_key)
        db.delete(document)
    db.execute(delete(Event).where(Event.application_id == application.id))
    audit(
        db, actor=Actor.CLIENT, user=user, action="DRAFT_DELETED", entity_type="application", entity_id=application.id
    )
    db.delete(application)
    db.commit()
    documents.discard(files)
    return Response(status_code=204)


@router.post("/applications/{application_id}/submit", response_model=ApplicationOut, summary="Отправить заявку")
def submit(
    application_id: uuid.UUID,
    body: SubmitRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", max_length=128),
    user: User = Depends(client_only),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    application = load(db, application_id, user, lock=True)
    scope = f"submit:{application.id}"
    if idempotency.lookup(db, user, scope, idempotency_key) is not None:
        return application_out(db, application, user)
    if application.status != AppStatus.DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Заявка уже отправлена")
    if not (body.consent_bki and body.consent_pd):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Без согласий на запрос в БКИ и обработку персональных данных мы не сможем рассмотреть заявку",
        )
    product = get_product(db, application.product_code)
    validate_terms(product, application.company, Decimal(application.amount), application.term_months)
    if product.collateral_required and not application.collateral_value:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите залог и его оценочную стоимость")
    for kind in (ConsentType.BKI, ConsentType.PD):
        db.add(Consent(application_id=application.id, kind=kind, given_by=user.id, text_version=CONSENT_TEXT_VERSION))
    transition(db, application, AppStatus.SUBMITTED, actor=Actor.CLIENT, user=user)
    idempotency.remember(db, user, scope, idempotency_key, {"status": AppStatus.SUBMITTED})
    db.commit()
    return application_out(db, application, user)


@router.post("/applications/{application_id}/cancel", response_model=ApplicationOut, summary="Отозвать заявку")
def cancel(
    application_id: uuid.UUID, user: User = Depends(client_only), db: Session = Depends(get_db)
) -> ApplicationOut:
    application = load(db, application_id, user, lock=True)
    transition(db, application, AppStatus.CANCELLED, actor=Actor.CLIENT, user=user, reason="Отозвана клиентом")
    for offer in db.scalars(select(Offer).where(Offer.application_id == application.id, Offer.status == "ACTIVE")):
        offer.status = OfferStatus.VOID
    for request in db.scalars(
        select(InfoRequest).where(InfoRequest.application_id == application.id, InfoRequest.status == InfoStatus.OPEN)
    ):
        request.status = InfoStatus.CANCELLED
    db.commit()
    return application_out(db, application, user)


@router.post(
    "/applications/{application_id}/documents",
    response_model=DocumentOut,
    status_code=201,
    summary="Загрузить документ (выписка разбирается автоматически)",
)
async def upload(
    application_id: uuid.UUID,
    file: UploadFile = File(...),
    kind: DocumentKind = Form(DocumentKind.OTHER),
    info_request_id: uuid.UUID | None = Form(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> DocumentOut:
    application = load(db, application_id, user)
    if kind in (DocumentKind.AGREEMENT, DocumentKind.SCHEDULE):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Этот тип документа формирует банк")
    allowed = {AppStatus.DRAFT, AppStatus.NEED_INFO} if user.role == Role.CLIENT else {AppStatus.MANUAL_REVIEW}
    if application.status not in allowed:
        raise HTTPException(status.HTTP_409_CONFLICT, "Сейчас нельзя добавить документ к заявке")
    if info_request_id is not None:
        request = db.get(InfoRequest, info_request_id)
        if request is None or request.application_id != application.id or request.status != InfoStatus.OPEN:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Запрос банка не найден или уже закрыт")
    data = await file.read()
    parsed = None
    if kind == DocumentKind.BANK_STATEMENT:
        try:
            parsed = parse_statement(file.filename or "statement", data)
        except StatementError as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Не удалось разобрать выписку: {error}"
            ) from None
    try:
        document = documents.store(
            db,
            application,
            file_name=file.filename or "file",
            content_type=file.content_type or "application/octet-stream",
            data=data,
            kind=kind,
            source=DocumentSource.CLIENT if user.role == Role.CLIENT else DocumentSource.BANK,
            user=user,
            info_request_id=info_request_id,
        )
    except documents.UploadError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from None
    document.parsed = parsed
    audit(
        db,
        actor=Actor(user.role),
        user=user,
        action="DOCUMENT_UPLOADED",
        entity_type="application",
        entity_id=application.id,
        details={"kind": kind, "file": document.file_name, "sha256": document.sha256},
    )
    events.refresh(db, application)
    db.commit()
    return next(d for d in documents_out(db, application) if d.id == document.id)


@router.get("/documents/{document_id}/download", summary="Скачать документ")
def download(document_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)) -> Response:
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Документ не найден")
    load(db, document.application_id, user)
    return Response(
        content=documents.read(document),
        media_type=document.content_type,
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(document.file_name)}"},
    )


@router.delete("/documents/{document_id}", status_code=204, summary="Удалить загруженный документ")
def delete_document(
    document_id: uuid.UUID, user: User = Depends(client_only), db: Session = Depends(get_db)
) -> Response:
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Документ не найден")
    application = load(db, document.application_id, user)
    if document.source != DocumentSource.CLIENT or application.status not in (AppStatus.DRAFT, AppStatus.NEED_INFO):
        raise HTTPException(status.HTTP_409_CONFLICT, "Этот документ удалить нельзя")
    stored = document.storage_key
    db.delete(document)
    events.refresh(db, application)
    db.commit()
    documents.discard([stored])
    return Response(status_code=204)


@router.post("/info-requests/{request_id}/answer", response_model=ApplicationOut, summary="Ответить на запрос банка")
def answer(
    request_id: uuid.UUID, body: InfoAnswer, user: User = Depends(client_only), db: Session = Depends(get_db)
) -> ApplicationOut:
    request = db.get(InfoRequest, request_id)
    if request is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Запрос не найден")
    application = load(db, request.application_id, user, lock=True)
    if request.status != InfoStatus.OPEN or application.status != AppStatus.NEED_INFO:
        raise HTTPException(status.HTTP_409_CONFLICT, "На этот запрос уже нельзя ответить")
    attached = db.scalars(select(Document).where(Document.info_request_id == request.id)).all()
    needs_statement = any(item.get("code") == "BANK_STATEMENT" for item in request.items)
    if needs_statement and not any(d.kind == DocumentKind.BANK_STATEMENT and d.parsed for d in attached):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Приложите выписку по счёту в формате 1С или CSV")
    if not attached and not (body.text and body.text.strip()):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Добавьте ответ или приложите документ")
    request.status = InfoStatus.ANSWERED
    request.answer_text = body.text
    request.answered_at = datetime.now(UTC)
    target = AppStatus.IN_PROCESSING if request.origin == InfoOrigin.SYSTEM else AppStatus.MANUAL_REVIEW
    transition(db, application, target, actor=Actor.CLIENT, user=user, reason="Клиент ответил на запрос")
    events.emit(
        db,
        application,
        audience=Audience.BANK,
        kind="INFO_ANSWERED",
        title=f"Клиент ответил на запрос по заявке № {application.number}",
        body=body.text,
    )
    db.commit()
    return application_out(db, application, user)


@router.get("/applications/{application_id}/messages", response_model=list[MessageOut], summary="Чат по заявке")
def messages(
    application_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[MessageOut]:
    application = load(db, application_id, user)
    rows = db.scalars(select(Message).where(Message.application_id == application.id).order_by(Message.id)).all()
    return [
        MessageOut(
            id=m.id, author_name=m.author.full_name, author_role=m.author_role, text=m.text, created_at=m.created_at
        )
        for m in rows
    ]


@router.post(
    "/applications/{application_id}/messages",
    response_model=MessageOut,
    status_code=201,
    summary="Написать в чат по заявке",
)
def send_message(
    application_id: uuid.UUID, body: MessageIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> MessageOut:
    application = load(db, application_id, user)
    if application.status == AppStatus.DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Чат доступен после отправки заявки")
    message = Message(application_id=application.id, author_id=user.id, author_role=user.role, text=body.text.strip())
    db.add(message)
    if user.role == Role.CLIENT:
        events.emit(
            db,
            application,
            audience=Audience.BANK,
            kind="MESSAGE",
            title=f"Новое сообщение по заявке № {application.number}",
            body=body.text[:200],
        )
    else:
        events.emit(
            db,
            application,
            audience=Audience.CLIENT,
            kind="MESSAGE",
            title=f"Сообщение от банка по заявке № {application.number}",
            body=body.text[:200],
        )
    db.commit()
    return MessageOut(
        id=message.id,
        author_name=user.full_name,
        author_role=user.role,
        text=message.text,
        created_at=message.created_at,
    )


@router.post("/offers/{offer_id}/accept", response_model=ApplicationOut, summary="Принять предложение")
def accept_offer(
    offer_id: uuid.UUID, user: User = Depends(client_only), db: Session = Depends(get_db)
) -> ApplicationOut:
    offer = db.get(Offer, offer_id)
    if offer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Предложение не найдено")
    application = load(db, offer.application_id, user, lock=True)
    if offer.status != OfferStatus.ACTIVE or offer.valid_until < datetime.now(UTC):
        raise HTTPException(status.HTTP_409_CONFLICT, "Предложение больше не действует")
    for other in db.scalars(select(Offer).where(Offer.application_id == application.id, Offer.status == "ACTIVE")):
        other.status = OfferStatus.VOID
    offer.status = OfferStatus.ACCEPTED
    offer.accepted_at = datetime.now(UTC)
    transition(
        db, application, AppStatus.ACCEPTED, actor=Actor.CLIENT, user=user, reason=f"Принят вариант {offer.option_no}"
    )
    db.commit()
    return application_out(db, application, user)


@router.post(
    "/applications/{application_id}/decline", response_model=ApplicationOut, summary="Отказаться от предложения"
)
def decline(
    application_id: uuid.UUID, user: User = Depends(client_only), db: Session = Depends(get_db)
) -> ApplicationOut:
    application = load(db, application_id, user, lock=True)
    transition(db, application, AppStatus.DECLINED, actor=Actor.CLIENT, user=user)
    for offer in db.scalars(select(Offer).where(Offer.application_id == application.id, Offer.status == "ACTIVE")):
        offer.status = OfferStatus.DECLINED
    db.commit()
    return application_out(db, application, user)


@router.post(
    "/applications/{application_id}/sign",
    response_model=ApplicationOut,
    summary="Подписать договор простой электронной подписью",
)
def sign(
    application_id: uuid.UUID,
    body: SignRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", max_length=128),
    user: User = Depends(client_only),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    application = load(db, application_id, user, lock=True)
    scope = f"sign:{application.id}"
    if idempotency.lookup(db, user, scope, idempotency_key) is not None:
        return application_out(db, application, user)
    if application.status != AppStatus.SIGNING:
        raise HTTPException(status.HTTP_409_CONFLICT, "Договор сейчас нельзя подписать")
    if not user.can_sign:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "У вас нет права подписи от имени компании")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Неверный пароль")
    agreement = db.scalars(
        select(Document)
        .where(Document.application_id == application.id, Document.kind == DocumentKind.AGREEMENT)
        .order_by(Document.created_at.desc())
    ).first()
    if agreement is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Договор ещё не сформирован")
    db.add(
        Signature(
            application_id=application.id,
            document_id=agreement.id,
            signer_role="CLIENT",
            signer_user_id=user.id,
            method="PEP_PASSWORD",
            document_sha256=agreement.sha256,
        )
    )
    db.add(
        Signature(
            application_id=application.id,
            document_id=agreement.id,
            signer_role="BANK",
            signer_user_id=None,
            method="BANK_AUTO",
            document_sha256=agreement.sha256,
        )
    )
    audit(
        db,
        actor=Actor.CLIENT,
        user=user,
        action="AGREEMENT_SIGNED",
        entity_type="application",
        entity_id=application.id,
        details={"document": str(agreement.id), "sha256": agreement.sha256},
    )
    transition(db, application, AppStatus.SIGNED, actor=Actor.CLIENT, user=user)
    idempotency.remember(db, user, scope, idempotency_key, {"status": AppStatus.SIGNED})
    db.commit()
    return application_out(db, application, user)


@router.get("/applications/{application_id}/loan", response_model=LoanOut | None, summary="Выданный кредит и график")
def loan(
    application_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> LoanOut | None:
    return loan_out(db, load(db, application_id, user))
