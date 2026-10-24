"""Защита входа от перебора паролей: блокировка после нескольких неудач, сброс при успехе, истечение окна, 429."""

from fastapi.testclient import TestClient

from app.db import get_db
from app.main import app
from app.services import login_limiter as module
from app.services.login_limiter import LoginLimiter, login_limiter, too_many_attempts, wait_text


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_blocks_after_attempts_and_releases_after_window():
    clock = Clock()
    limiter = LoginLimiter(attempts=3, window_seconds=60, clock=clock)
    key = "veter|10.0.0.1"
    assert limiter.failed(key) is None
    assert limiter.failed(key) is None
    assert limiter.retry_after(key) is None
    assert limiter.failed(key) == 60  # третья неудача — блокировка на всё окно
    assert limiter.retry_after(key) == 60
    clock.now += 59
    assert limiter.retry_after(key) == 1
    clock.now += 1
    assert limiter.retry_after(key) is None
    assert limiter.failed(key) is None  # после блокировки счёт начинается заново


def test_old_failures_outside_window_are_forgotten():
    clock = Clock()
    limiter = LoginLimiter(attempts=3, window_seconds=60, clock=clock)
    limiter.failed("veter|ip")
    limiter.failed("veter|ip")
    clock.now += 61
    assert limiter.failed("veter|ip") is None  # первая неудача в новом окне
    assert limiter.failed("veter|ip") is None
    assert limiter.failed("veter|ip") == 60


def test_success_resets_and_keys_are_independent():
    limiter = LoginLimiter(attempts=2, window_seconds=60, clock=Clock())
    limiter.failed("veter|ip1")
    limiter.succeeded("veter|ip1")
    assert limiter.failed("veter|ip1") is None
    # другой адрес и другой логин ведут свой счёт
    assert limiter.failed("veter|ip2") is None
    assert limiter.failed("veter|ip2") == 60
    assert limiter.retry_after("veter|ip1") is None
    assert limiter.retry_after("smirnova|ip2") is None
    limiter.clear()
    assert limiter.retry_after("veter|ip2") is None


def test_stale_entries_are_pruned(monkeypatch):
    monkeypatch.setattr(module, "PRUNE_AT", 3)
    clock = Clock()
    limiter = LoginLimiter(attempts=5, window_seconds=60, clock=clock)
    for i in range(3):
        limiter.failed(f"login{i}|ip")
    clock.now += 61
    limiter.failed("fresh|ip")
    assert len(limiter) == 1


def test_wait_text_declension():
    assert wait_text(300) == "5 минут"
    assert wait_text(60) == "1 минуту"
    assert wait_text(61) == "2 минуты"
    assert wait_text(40) == "40 секунд"
    assert wait_text(22) == "22 секунды"
    assert wait_text(1) == "1 секунду"
    assert too_many_attempts(300) == "Слишком много попыток входа. Повторите через 5 минут"


class FakeScalars:
    def first(self):
        return None


class FakeDb:
    def __init__(self) -> None:
        self.added: list = []

    def scalars(self, *_):
        return FakeScalars()

    def add(self, obj) -> None:
        self.added.append(obj)

    def commit(self) -> None:
        pass


def test_login_endpoint_answers_429_with_retry_after():
    fake = FakeDb()
    app.dependency_overrides[get_db] = lambda: fake
    login_limiter.cache_clear()
    try:
        client = TestClient(app)
        limiter = login_limiter()
        body = {"login": "Nobody ", "password": "wrong"}
        for _ in range(limiter.attempts - 1):
            response = client.post("/api/auth/login", json=body)
            assert response.status_code == 401
            assert response.json()["detail"] == "Неверный логин или пароль"
        response = client.post("/api/auth/login", json=body)
        assert response.status_code == 429
        assert response.headers["Retry-After"] == str(limiter.window)
        assert response.json()["detail"] == too_many_attempts(limiter.window)
        # пока блокировка действует, пароль не проверяется и запись в журнал не добавляется
        assert client.post("/api/auth/login", json=body).status_code == 429
        # другой логин с того же адреса не затронут
        assert client.post("/api/auth/login", json={"login": "other", "password": "x"}).status_code == 401

        failed = [row for row in fake.added if row.action == "LOGIN_FAILED"]
        assert len(failed) == limiter.attempts + 1
        nobody = [row for row in failed if row.details["login"] == "nobody"]
        assert len(nobody) == limiter.attempts
        assert nobody[0].entity_id == "nobody" and nobody[0].actor == "SYSTEM" and nobody[0].actor_user_id is None
        assert [row.details["blocked_seconds"] for row in nobody] == [None] * (limiter.attempts - 1) + [limiter.window]
    finally:
        app.dependency_overrides.clear()
        login_limiter.cache_clear()
