"""Защита входа от перебора паролей: после нескольких неверных паролей логин с этого адреса временно блокируется.

Счётчик ведётся по паре «логин + адрес», поэтому злоумышленник с другого адреса не может заблокировать вход
настоящему пользователю. Состояние хранится в памяти процесса API: стенд работает одним экземпляром, а при
горизонтальном масштабировании счётчик выносится во внешнее хранилище (Redis) без изменения этого интерфейса.
"""

import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache

from app.config import get_settings
from app.domain.text import plural

# Записей больше этого — чистим устаревшие, чтобы память не росла от перебора логинов
PRUNE_AT = 10_000


@dataclass
class _Entry:
    first_failure: float
    failures: int = 0
    blocked_until: float = 0.0


class LoginLimiter:
    """``attempts`` неудач за ``window_seconds`` блокируют ключ на то же время; успешный вход обнуляет счётчик."""

    def __init__(self, attempts: int, window_seconds: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.attempts = max(1, attempts)
        self.window = max(1, window_seconds)
        self._clock = clock
        self._entries: dict[str, _Entry] = {}
        self._lock = threading.Lock()

    def retry_after(self, key: str) -> int | None:
        """Сколько секунд ждать, если ключ заблокирован; None — попытку можно проверять."""
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if entry.blocked_until > now:
                return max(1, math.ceil(entry.blocked_until - now))
            if entry.blocked_until or now - entry.first_failure > self.window:
                del self._entries[key]  # блокировка отработала или неудачи устарели
            return None

    def failed(self, key: str) -> int | None:
        """Зафиксировать неверный пароль. Возвращает срок блокировки в секундах, если этой попыткой лимит исчерпан."""
        now = self._clock()
        with self._lock:
            if len(self._entries) >= PRUNE_AT:
                self._prune(now)
            entry = self._entries.get(key)
            if entry is None or (not entry.blocked_until and now - entry.first_failure > self.window):
                entry = self._entries[key] = _Entry(first_failure=now)
            entry.failures += 1
            if entry.failures >= self.attempts:
                entry.blocked_until = now + self.window
                return self.window
            return None

    def succeeded(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def _prune(self, now: float) -> None:
        stale = [
            key
            for key, entry in self._entries.items()
            if (entry.blocked_until and entry.blocked_until <= now)
            or (not entry.blocked_until and now - entry.first_failure > self.window)
        ]
        for key in stale:
            del self._entries[key]


def wait_text(seconds: int) -> str:
    """«5 минут», «1 минуту», «40 секунд» — для сообщения «Повторите через …»."""
    if seconds >= 60:
        minutes = math.ceil(seconds / 60)
        return f"{minutes} {plural(minutes, 'минуту', 'минуты', 'минут')}"
    return f"{seconds} {plural(seconds, 'секунду', 'секунды', 'секунд')}"


def too_many_attempts(seconds: int) -> str:
    return f"Слишком много попыток входа. Повторите через {wait_text(seconds)}"


@lru_cache
def login_limiter() -> LoginLimiter:
    settings = get_settings()
    return LoginLimiter(settings.login_attempts, settings.login_window_seconds)
