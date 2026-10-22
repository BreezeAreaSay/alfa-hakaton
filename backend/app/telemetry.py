"""Метрики Prometheus для api и worker: запросы, задания и шаги конвейера, внешние вызовы, решения.

`api` отдаёт их на /metrics, `worker` — на отдельном порту (WORKER_METRICS_PORT). Оба доступны только внутри
сети Docker; собирает их Prometheus из профиля monitoring (docker compose --profile monitoring up).
"""

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

HTTP_REQUESTS = Counter("http_requests_total", "Запросы к API", ["method", "route", "status"])
HTTP_DURATION = Histogram(
    "http_request_duration_seconds",
    "Время ответа API по маршрутам",
    ["method", "route"],
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)
JOBS = Counter("pipeline_jobs_total", "Задания конвейера по результату", ["kind", "result"])
JOB_DURATION = Histogram(
    "pipeline_job_duration_seconds",
    "Время выполнения задания конвейера",
    ["kind"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
)
STEPS = Counter("pipeline_steps_total", "Шаги конвейера по статусу", ["step", "status"])
DECISIONS = Counter("decisions_total", "Решения по заявкам", ["kind", "outcome"])
EXTERNAL_CALLS = Counter("external_calls_total", "Вызовы внешних систем по результату", ["source", "result"])
EXTERNAL_DURATION = Histogram(
    "external_call_duration_seconds",
    "Время ответа внешней системы",
    ["source"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5),
)
BREAKER_OPEN = Gauge("circuit_breaker_open", "1 — вызовы источника приостановлены после серии ошибок", ["source"])
QUEUE_JOBS = Gauge("queue_jobs", "Задания в очереди по статусу", ["status"])
APPLICATIONS = Gauge("applications", "Заявки по статусу", ["status"])


def observe_request(method: str, route: str, status: int, seconds: float) -> None:
    HTTP_REQUESTS.labels(method=method, route=route, status=str(status)).inc()
    HTTP_DURATION.labels(method=method, route=route).observe(seconds)


def metrics_payload() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
