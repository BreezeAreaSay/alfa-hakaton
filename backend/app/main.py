import logging
import time
import uuid

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm.exc import StaleDataError

from app.api import admin, ai, applications, auth, bank, catalog, notifications
from app.logging_setup import setup_logging
from app.services.audit import request_id_var
from app.services.workflow import TransitionError
from app.telemetry import metrics_payload, observe_request

setup_logging()
log = logging.getLogger("api")

DESCRIPTION = """
API цифрового кредитного конвейера для малого и микробизнеса.

* **Клиент** подбирает продукт, подаёт заявку, отвечает на запросы банка, принимает предложение и подписывает договор.
* **Аналитик** работает с очередью, досье, скорингом и принимает решения в пределах полномочий.
* **Администратор** сбрасывает демо-данные и включает сбои внешних систем.

Авторизация: `POST /api/auth/login` → заголовок `Authorization: Bearer <token>`.
Тестовые учётные записи — в README.
"""

app = FastAPI(
    title="Умный кредитный кабинет — API",
    version="1.0.0",
    description=DESCRIPTION,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
    token = request_id_var.set(request_id)
    started = time.monotonic()
    try:
        response = await call_next(request)
    finally:
        request_id_var.reset(token)
    response.headers["X-Request-ID"] = request_id
    path = request.url.path
    if path.startswith("/api") and path != "/api/stream":
        # Метрики по шаблону маршрута, а не по адресу: /api/applications/{application_id} — один ряд
        route = request.scope.get("route")
        observe_request(
            request.method,
            getattr(route, "path", None) or "unmatched",
            response.status_code,
            time.monotonic() - started,
        )
    if path.startswith("/api") and path not in ("/api/health", "/api/stream"):
        log.info(
            "HTTP",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": round((time.monotonic() - started) * 1000),
            },
        )
    return response


@app.get("/metrics", include_in_schema=False)
def metrics() -> Response:
    """Метрики Prometheus. Наружу через nginx не проксируется — только внутри сети Docker."""
    payload, content_type = metrics_payload()
    return Response(payload, media_type=content_type)


@app.exception_handler(TransitionError)
async def transition_error(_: Request, error: TransitionError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(error)})


@app.exception_handler(StaleDataError)
async def stale_data(_: Request, __: StaleDataError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": "Заявка изменилась, обновите страницу"})


for module in (auth, catalog, applications, notifications, bank, admin, ai):
    app.include_router(module.router)
app.include_router(catalog.service)
