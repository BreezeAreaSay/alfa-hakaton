from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.domain.enums import Actor
from app.models import User
from app.schemas import LoginRequest, LoginResponse, UserOut
from app.security import create_token, current_user, verify_password
from app.services.audit import audit
from app.services.login_limiter import login_limiter, too_many_attempts
from app.services.views import user_out

router = APIRouter(prefix="/api", tags=["Вход"])


def client_ip(request: Request) -> str:
    """Адрес клиента: за nginx и Caddy uvicorn берёт его из X-Forwarded-For (--proxy-headers)."""
    return request.client.host if request.client else "-"


@router.post(
    "/auth/login",
    response_model=LoginResponse,
    summary="Вход по логину и паролю",
    responses={
        401: {"description": "Неверный логин или пароль"},
        429: {"description": "Слишком много неверных паролей: логин с этого адреса временно заблокирован, Retry-After"},
    },
)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)) -> LoginResponse:
    """После `LOGIN_ATTEMPTS` неверных паролей (по умолчанию 5) логин блокируется с этого адреса
    на `LOGIN_WINDOW_SECONDS` (5 минут). Неудачные попытки записываются в журнал действий."""
    login_name = body.login.strip().lower()
    ip = client_ip(request)
    limiter = login_limiter()
    key = f"{login_name}|{ip}"
    wait = limiter.retry_after(key)
    if wait is not None:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, too_many_attempts(wait), {"Retry-After": str(wait)})
    user = db.scalars(select(User).where(User.login == login_name)).first()
    if user is None or not verify_password(body.password, user.password_hash):
        blocked = limiter.failed(key)
        audit(
            db,
            actor=Actor.SYSTEM,
            user=None,
            action="LOGIN_FAILED",
            entity_type="user",
            entity_id=user.id if user else login_name[:64],
            details={"login": login_name, "ip": ip, "blocked_seconds": blocked},
        )
        db.commit()
        if blocked is not None:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS, too_many_attempts(blocked), {"Retry-After": str(blocked)}
            )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный логин или пароль")
    limiter.succeeded(key)
    audit(
        db,
        actor=Actor(user.role),
        user=user,
        action="LOGIN",
        entity_type="user",
        entity_id=user.id,
    )
    db.commit()
    return LoginResponse(token=create_token(user), user=user_out(user))


@router.get("/me", response_model=UserOut, summary="Текущий пользователь")
def me(user: User = Depends(current_user)) -> UserOut:
    return user_out(user)
