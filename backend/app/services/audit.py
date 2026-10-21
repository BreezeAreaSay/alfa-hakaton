import contextvars
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditLog, User

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)


def audit(
    db: Session,
    *,
    actor: str,
    user: User | None,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | str,
    details: dict[str, Any] | None = None,
) -> None:
    db.add(
        AuditLog(
            actor=actor,
            actor_user_id=user.id if user else None,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            details=details or {},
            request_id=request_id_var.get(),
        )
    )
