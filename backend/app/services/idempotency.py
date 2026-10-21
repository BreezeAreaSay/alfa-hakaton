"""Идемпотентность действий: повтор запроса с тем же ключом возвращает сохранённый ответ."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import IdempotencyKey, User


def lookup(db: Session, user: User, scope: str, key: str | None) -> dict[str, Any] | None:
    if not key:
        return None
    row = db.scalars(
        select(IdempotencyKey).where(
            IdempotencyKey.user_id == user.id, IdempotencyKey.scope == scope, IdempotencyKey.key == key
        )
    ).first()
    return row.response if row else None


def remember(db: Session, user: User, scope: str, key: str | None, response: dict[str, Any]) -> None:
    if key:
        db.add(IdempotencyKey(user_id=user.id, scope=scope, key=key, response=response))
