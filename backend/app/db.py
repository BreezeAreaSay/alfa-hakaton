from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


engine = create_engine(get_settings().database_url, pool_pre_ping=True, pool_size=10, max_overflow=20)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# SQLSTATE «deadlock detected»: Postgres прервал одну из двух транзакций, ждавших блокировки друг друга
DEADLOCK_DETECTED = "40P01"


def is_deadlock(error: BaseException) -> bool:
    """Ошибка базы — взаимная блокировка: транзакцию можно просто повторить."""
    return getattr(getattr(error, "orig", None), "sqlstate", None) == DEADLOCK_DETECTED
