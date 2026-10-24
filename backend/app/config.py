from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_JWT_SECRET = "change-me-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://credit:credit@localhost:5432/credit"
    simulator_url: str = "http://localhost:8100"
    jwt_secret: str = DEFAULT_JWT_SECRET
    jwt_ttl_minutes: int = 12 * 60
    # Неверных паролей по логину с одного адреса до блокировки и её длительность (docs/architecture.md, «Безопасность»)
    login_attempts: int = 5
    login_window_seconds: int = 300
    files_dir: str = "/data/files"
    max_upload_mb: int = 10

    # Таймеры процесса (docs/process.md, раздел «Таймеры»)
    offer_ttl_hours: int = 7 * 24
    info_request_ttl_hours: int = 3 * 24
    review_sla_hours: int = 24
    source_wait_limit_minutes: int = 15
    # Заявка на ручном рассмотрении сразу назначается наименее загруженному аналитику (docs/process.md,
    # «Очередь аналитиков»); false — заявки ждут в общей очереди, пока аналитик не возьмёт их сам
    auto_assign: bool = True

    # Внешние вызовы
    external_timeout_seconds: float = 3.0
    retry_base_seconds: float = 2.0
    retry_max_seconds: float = 30.0
    breaker_failure_threshold: int = 5
    breaker_open_seconds: float = 20.0

    # Обработчик конвейера
    worker_concurrency: int = 4  # потоков на один процесс: шаги ждут ответов внешних систем, а не процессора
    worker_metrics_port: int = 9100  # метрики Prometheus обработчика; 0 — не отдавать
    worker_poll_seconds: float = 0.5
    worker_sweep_seconds: float = 10.0
    job_lock_timeout_seconds: int = 120

    # ИИ (необязательно)
    ai_enabled: bool = False
    llm_base_url: str = "http://host.docker.internal:11434/v1"
    llm_api_key: str = ""
    llm_model: str = "qwen3:4b"
    llm_timeout_seconds: float = 40.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
