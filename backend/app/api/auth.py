from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.domain.enums import Actor
from app.models import User
from app.schemas import LoginRequest, LoginResponse, UserOut
from app.security import create_token, current_user, verify_password
from app.services.audit import audit
from app.services.views import user_out

router = APIRouter(prefix="/api", tags=["Вход"])


@router.post("/auth/login", response_model=LoginResponse, summary="Вход по логину и паролю")
def login(body: LoginRequest, db: Session = Depends(get_db)) -> LoginResponse:
    user = db.scalars(select(User).where(User.login == body.login.strip().lower())).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный логин или пароль")
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
