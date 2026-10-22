"""Клиент внешних систем (в демо — симулятор): таймауты, разделение ошибок, circuit breaker."""

import threading
import time
from typing import Any

import httpx

from app.config import get_settings
from app.telemetry import BREAKER_OPEN, EXTERNAL_CALLS, EXTERNAL_DURATION


class SourceUnavailable(Exception):
    """Временная ошибка: источник не ответил или ответил ошибкой. Шаг нужно повторить."""


class SourceNotFound(Exception):
    """Источник ответил, что данных нет. Повтор не поможет."""


class CircuitBreaker:
    """Если источник подряд отвечает ошибками, перестаём его вызывать на время, чтобы не перегружать."""

    def __init__(self, threshold: int, open_seconds: float) -> None:
        self.threshold = threshold
        self.open_seconds = open_seconds
        self.failures = 0
        self.open_until = 0.0
        self._lock = threading.Lock()

    def before_call(self, source: str) -> None:
        if time.monotonic() < self.open_until:
            raise SourceUnavailable(f"{source}: вызовы приостановлены после серии ошибок")

    def success(self) -> None:
        with self._lock:
            self.failures = 0

    def failure(self) -> None:
        with self._lock:
            self.failures += 1
            if self.failures >= self.threshold:
                self.open_until = time.monotonic() + self.open_seconds
                self.failures = 0

    @property
    def is_open(self) -> bool:
        return time.monotonic() < self.open_until


class ExternalSystems:
    def __init__(self, base_url: str | None = None, timeout: float | None = None) -> None:
        settings = get_settings()
        self.client = httpx.Client(
            base_url=base_url or settings.simulator_url,
            timeout=timeout or settings.external_timeout_seconds,
        )
        self.breakers: dict[str, CircuitBreaker] = {}
        self._settings = settings

    def _breaker(self, source: str) -> CircuitBreaker:
        if source not in self.breakers:
            self.breakers[source] = CircuitBreaker(
                self._settings.breaker_failure_threshold, self._settings.breaker_open_seconds
            )
        return self.breakers[source]

    def _observe(self, source: str, started: float | None, result: str) -> None:
        EXTERNAL_CALLS.labels(source=source, result=result).inc()
        if started is not None:
            EXTERNAL_DURATION.labels(source=source).observe(time.monotonic() - started)
        BREAKER_OPEN.labels(source=source).set(1 if self._breaker(source).is_open else 0)

    def _call(self, source: str, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        breaker = self._breaker(source)
        try:
            breaker.before_call(source)
        except SourceUnavailable:
            self._observe(source, None, "breaker_open")
            raise
        started = time.monotonic()
        try:
            response = self.client.request(method, url, **kwargs)
        except httpx.TimeoutException:
            breaker.failure()
            self._observe(source, started, "timeout")
            raise SourceUnavailable(f"{source}: превышено время ожидания ответа") from None
        except httpx.HTTPError as error:
            breaker.failure()
            self._observe(source, started, "connection_error")
            raise SourceUnavailable(f"{source}: нет соединения ({error.__class__.__name__})") from None
        if response.status_code == 404:
            breaker.success()
            self._observe(source, started, "not_found")
            raise SourceNotFound(response.json().get("detail", "не найдено"))
        if response.status_code >= 500:
            breaker.failure()
            self._observe(source, started, "server_error")
            raise SourceUnavailable(f"{source}: сервис ответил ошибкой {response.status_code}")
        response.raise_for_status()
        breaker.success()
        self._observe(source, started, "ok")
        return response.json()

    def egrul(self, inn: str) -> dict[str, Any]:
        return self._call("egrul", "GET", f"/egrul/{inn}")

    def fns(self, inn: str) -> dict[str, Any]:
        return self._call("fns", "GET", f"/fns/{inn}")

    def girbo(self, inn: str) -> dict[str, Any]:
        return self._call("girbo", "GET", f"/girbo/{inn}")

    def bki(self, inn: str, consent_id: str) -> dict[str, Any]:
        return self._call("bki", "POST", "/bki/report", json={"inn": inn, "consent_id": consent_id})

    def bank(self, inn: str) -> dict[str, Any]:
        return self._call("bank", "GET", f"/bank/clients/{inn}")

    def disburse(
        self, *, inn: str, application_number: str, amount: float, rate: float, term_months: int
    ) -> dict[str, Any]:
        payload = {
            "inn": inn,
            "application_number": application_number,
            "amount": amount,
            "rate": rate,
            "term_months": term_months,
        }
        return self._call("core", "POST", "/core/loans", json=payload)

    # Управление сбоями для демонстрации устойчивости (доступно администратору).
    def faults(self) -> dict[str, Any]:
        return self.client.get("/admin/faults").json()

    def set_fault(self, source: str, mode: str, latency_ms: int = 0) -> dict[str, Any]:
        return self.client.put(f"/admin/faults/{source}", json={"mode": mode, "latency_ms": latency_ms}).json()

    def reset_faults(self) -> dict[str, Any]:
        return self.client.post("/admin/faults/reset").json()


_instance: ExternalSystems | None = None


def external_systems() -> ExternalSystems:
    global _instance
    if _instance is None:
        _instance = ExternalSystems()
    return _instance
