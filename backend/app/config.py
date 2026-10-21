from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://credit:credit@localhost:5432/credit"
    simulator_url: str = "http://localhost:8100"
    jwt_secret: str = "change-me-in-production"
    jwt_ttl_minutes: int = 12 * 60
    files_dir: str = "/data/files"
    max_upload_mb: int = 10

    # Таймеры процесса (docs/process.md, раздел «Таймеры»)
    offer_ttl_hours: int = 7 * 24
    info_request_ttl_hours: int = 3 * 24
    review_sla_hours: int = 24
    source_wait_limit_minutes: int = 15

    # Внешние вызовы
    external_timeout_seconds: float = 3.0
    retry_base_seconds: float = 2.0
    retry_max_seconds: float = 30.0
    breaker_failure_threshold: int = 5
    breaker_open_seconds: float = 20.0

    # Обработчик конвейера
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
