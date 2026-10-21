"""События для ленты уведомлений и потока SSE. Пишутся в той же транзакции, что и изменение данных."""

from typing import Any

from sqlalchemy.orm import Session

from app.domain.enums import Audience
from app.models import Application, Event


def emit(
    db: Session,
    application: Application | None,
    *,
    audience: Audience,
    kind: str,
    title: str,
    body: str | None = None,
    notify: bool = True,
    payload: dict[str, Any] | None = None,
) -> None:
    db.add(
        Event(
            application_id=application.id if application else None,
            company_id=application.company_id if application else None,
            audience=audience,
            kind=kind,
            title=title,
            body=body,
            notify=notify,
            payload=payload or {},
        )
    )


def refresh(db: Session, application: Application, kind: str = "UPDATED") -> None:
    """Сигнал интерфейсам обновить данные заявки без уведомления в ленте."""
    emit(db, application, audience=Audience.ALL, kind=kind, title=kind, notify=False)
