"""Лента уведомлений и поток событий (Server-Sent Events) — все уведомления только внутри продукта."""

import asyncio
import json
import uuid

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal, get_db
from app.domain.enums import Audience, Role
from app.models import Event, User
from app.schemas import NotificationOut, NotificationsOut
from app.security import current_user

router = APIRouter(prefix="/api", tags=["Уведомления"])


def scope(user: User):
    if user.role == Role.CLIENT:
        return (Event.company_id == user.company_id) & Event.audience.in_([Audience.CLIENT, Audience.ALL])
    return Event.audience.in_([Audience.BANK, Audience.ALL])


@router.get("/notifications", response_model=NotificationsOut, summary="Лента уведомлений")
def notifications(user: User = Depends(current_user), db: Session = Depends(get_db)) -> NotificationsOut:
    condition = scope(user) & Event.notify
    rows = db.scalars(select(Event).where(condition).order_by(Event.id.desc()).limit(50)).all()
    unread = db.scalar(select(func.count()).select_from(Event).where(condition, Event.id > user.last_read_event_id))
    return NotificationsOut(
        unread=unread or 0,
        items=[
            NotificationOut(
                id=e.id,
                application_id=e.application_id,
                kind=e.kind,
                title=e.title,
                body=e.body,
                created_at=e.created_at,
                unread=e.id > user.last_read_event_id,
            )
            for e in rows
        ],
    )


@router.post("/notifications/read", status_code=204, summary="Отметить уведомления прочитанными")
def mark_read(user: User = Depends(current_user), db: Session = Depends(get_db)) -> None:
    latest = db.scalar(select(func.max(Event.id)).where(scope(user)))
    user.last_read_event_id = latest or 0
    db.commit()


def _user_from_request(request: Request) -> User:
    header = request.headers.get("Authorization", "")
    token = header.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Нужно войти заново") from None
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Нужно войти заново")
        db.expunge(user)
        return user


def _fetch(user: User, after_id: int) -> list[dict]:
    with SessionLocal() as db:
        if after_id < 0:
            return [{"id": db.scalar(select(func.max(Event.id))) or 0, "init": True}]
        rows = db.scalars(select(Event).where(scope(user), Event.id > after_id).order_by(Event.id).limit(100)).all()
        return [
            {
                "id": e.id,
                "kind": e.kind,
                "application_id": str(e.application_id) if e.application_id else None,
                "title": e.title,
                "notify": e.notify,
            }
            for e in rows
        ]


@router.get("/stream", summary="Поток событий для обновления интерфейса без перезагрузки (SSE)")
async def stream(request: Request) -> StreamingResponse:
    user = await run_in_threadpool(_user_from_request, request)
    last_event = request.headers.get("Last-Event-ID")

    async def generate():
        if last_event and last_event.isdigit():
            last_id = int(last_event)
        else:
            last_id = (await run_in_threadpool(_fetch, user, -1))[0]["id"]
        yield "retry: 3000\n\n"
        ticks = 0
        while not await request.is_disconnected():
            for event in await run_in_threadpool(_fetch, user, last_id):
                last_id = event["id"]
                yield f"id: {event['id']}\nevent: message\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            ticks += 1
            if ticks % 15 == 0:
                yield ": ping\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
