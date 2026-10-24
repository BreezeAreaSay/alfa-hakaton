"""Чат с поддержкой: клиент пишет из окна справа внизу, администратор видит чаты всех клиентов и отвечает.

У клиента одна ветка — его собственная (client_id = id пользователя). Сообщения не привязаны к заявке.
События SUPPORT без уведомления в ленте: они только обновляют окно поддержки у другой стороны.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, func, select, update
from sqlalchemy.orm import Session

from app.db import get_db
from app.domain.enums import Audience, Role
from app.models import SupportMessage, User
from app.schemas import MessageIn, MessageOut, SupportChatOut, SupportThreadOut
from app.security import require_roles
from app.services import events

router = APIRouter(prefix="/api/support", tags=["Поддержка"])

client_only = require_roles(Role.CLIENT)
admin_only = require_roles(Role.ADMIN)


def _message_out(message: SupportMessage) -> MessageOut:
    return MessageOut(
        id=message.id,
        author_name=message.author.full_name,
        author_role=message.author_role,
        text=message.text,
        created_at=message.created_at,
    )


def _incoming(reader: User):
    """Сообщения, которые читает reader: клиенту — ответы поддержки, администратору — сообщения клиента."""
    if reader.role == Role.CLIENT:
        return SupportMessage.author_role != Role.CLIENT
    return SupportMessage.author_role == Role.CLIENT


def _chat(db: Session, client_id: uuid.UUID, reader: User) -> SupportChatOut:
    rows = db.scalars(select(SupportMessage).where(SupportMessage.client_id == client_id).order_by(SupportMessage.id))
    unread = db.scalar(
        select(func.count())
        .select_from(SupportMessage)
        .where(SupportMessage.client_id == client_id, _incoming(reader), SupportMessage.read_at.is_(None))
    )
    return SupportChatOut(messages=[_message_out(m) for m in rows], unread=unread or 0)


def _mark_read(db: Session, client_id: uuid.UUID, reader: User) -> None:
    db.execute(
        update(SupportMessage)
        .where(SupportMessage.client_id == client_id, _incoming(reader), SupportMessage.read_at.is_(None))
        .values(read_at=datetime.now(UTC))
    )
    db.commit()


def _client(db: Session, client_id: uuid.UUID) -> User:
    client = db.get(User, client_id)
    if client is None or client.role != Role.CLIENT:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Клиент не найден")
    return client


@router.get("", response_model=SupportChatOut, summary="Мой чат с поддержкой")
def my_chat(user: User = Depends(client_only), db: Session = Depends(get_db)) -> SupportChatOut:
    return _chat(db, user.id, user)


@router.post("/messages", response_model=MessageOut, status_code=201, summary="Написать в поддержку")
def write(body: MessageIn, user: User = Depends(client_only), db: Session = Depends(get_db)) -> MessageOut:
    message = SupportMessage(client_id=user.id, author_id=user.id, author_role=user.role, text=body.text.strip())
    db.add(message)
    events.emit(
        db,
        None,
        audience=Audience.BANK,
        kind="SUPPORT",
        title="Новое сообщение в поддержку",
        body=message.text[:200],
        notify=False,
        payload={"client_id": str(user.id)},
    )
    db.commit()
    return _message_out(message)


@router.post("/read", status_code=204, summary="Отметить ответы поддержки прочитанными")
def read_mine(user: User = Depends(client_only), db: Session = Depends(get_db)) -> None:
    _mark_read(db, user.id, user)


@router.get("/threads", response_model=list[SupportThreadOut], summary="Чаты клиентов с поддержкой")
def threads(user: User = Depends(admin_only), db: Session = Depends(get_db)) -> list[SupportThreadOut]:
    # Последнее сообщение и число непрочитанных по каждому клиенту — одним запросом, новые чаты сверху
    unread_filter = and_(SupportMessage.author_role == Role.CLIENT, SupportMessage.read_at.is_(None))
    summary = (
        select(
            SupportMessage.client_id,
            func.max(SupportMessage.id).label("last_id"),
            func.count().filter(unread_filter).label("unread"),
        )
        .group_by(SupportMessage.client_id)
        .subquery()
    )
    rows = db.execute(
        select(SupportMessage, summary.c.unread)
        .join(summary, SupportMessage.id == summary.c.last_id)
        .order_by(SupportMessage.id.desc())
    ).all()
    return [
        SupportThreadOut(
            client_id=message.client_id,
            client_name=message.client.full_name,
            company_name=message.client.company.name if message.client.company else None,
            last_text=message.text,
            last_author_role=message.author_role,
            last_at=message.created_at,
            unread=unread,
        )
        for message, unread in rows
    ]


@router.get("/threads/{client_id}", response_model=SupportChatOut, summary="Чат клиента с поддержкой")
def thread(client_id: uuid.UUID, user: User = Depends(admin_only), db: Session = Depends(get_db)) -> SupportChatOut:
    return _chat(db, _client(db, client_id).id, user)


@router.post("/threads/{client_id}/messages", response_model=MessageOut, status_code=201, summary="Ответить клиенту")
def reply(
    client_id: uuid.UUID, body: MessageIn, user: User = Depends(admin_only), db: Session = Depends(get_db)
) -> MessageOut:
    client = _client(db, client_id)
    message = SupportMessage(client_id=client.id, author_id=user.id, author_role=user.role, text=body.text.strip())
    db.add(message)
    events.emit(
        db,
        None,
        audience=Audience.CLIENT,
        kind="SUPPORT",
        title="Ответ поддержки",
        body=message.text[:200],
        notify=False,
        company_id=client.company_id,
    )
    # другие открытые окна администратора тоже обновят колонку чатов
    events.emit(db, None, audience=Audience.BANK, kind="SUPPORT", title="Ответ поддержки", notify=False)
    db.commit()
    return _message_out(message)


@router.post("/threads/{client_id}/read", status_code=204, summary="Отметить сообщения клиента прочитанными")
def read_thread(client_id: uuid.UUID, user: User = Depends(admin_only), db: Session = Depends(get_db)) -> None:
    _mark_read(db, _client(db, client_id).id, user)
