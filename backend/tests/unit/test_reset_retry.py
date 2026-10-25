"""Сброс демо-данных повторяется при взаимной блокировке с обработчиком заявок, другие ошибки не повторяет."""

from contextlib import nullcontext

import pytest
from sqlalchemy.exc import OperationalError

from app.db import DEADLOCK_DETECTED
from app.seed import demo


class FakeSession:
    """Сессия без базы: считает точки сохранения, в которых шёл сброс."""

    def __init__(self) -> None:
        self.savepoints = 0

    def begin_nested(self) -> nullcontext:
        self.savepoints += 1
        return nullcontext()


class PgError(Exception):
    def __init__(self, sqlstate: str) -> None:
        super().__init__(sqlstate)
        self.sqlstate = sqlstate


@pytest.fixture
def failing_reset(monkeypatch: pytest.MonkeyPatch):
    """Подменяет один проход сброса: первые `times` раз — ошибка Postgres `sqlstate`, затем 2 созданные заявки."""

    def install(times: int, sqlstate: str) -> dict[str, int]:
        calls = {"n": 0}

        def reset_once(db: FakeSession) -> int:
            calls["n"] += 1
            if calls["n"] <= times:
                raise OperationalError("TRUNCATE applications", {}, PgError(sqlstate))
            return 2

        monkeypatch.setattr(demo, "_reset_once", reset_once)
        monkeypatch.setattr(demo, "RESET_PAUSE_SECONDS", 0)
        return calls

    return install


def test_deadlock_is_retried_in_a_new_savepoint(failing_reset) -> None:
    calls = failing_reset(1, DEADLOCK_DETECTED)
    db = FakeSession()
    assert demo.reset_demo(db) == 2
    assert calls["n"] == 2
    assert db.savepoints == 2


def test_other_database_errors_are_not_retried(failing_reset) -> None:
    calls = failing_reset(1, "57014")  # запрос отменён — повтор не поможет
    with pytest.raises(OperationalError):
        demo.reset_demo(FakeSession())
    assert calls["n"] == 1


def test_gives_up_after_the_last_attempt(failing_reset) -> None:
    calls = failing_reset(10, DEADLOCK_DETECTED)
    with pytest.raises(OperationalError):
        demo.reset_demo(FakeSession())
    assert calls["n"] == demo.RESET_ATTEMPTS
