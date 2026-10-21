"""ИИ-функции (необязательные). Основной сценарий работает без них."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app.domain.enums import AppStatus
from app.domain.policy import FLAGS
from app.models import Application, User
from app.pipeline.steps import collect_inputs, run_results
from app.security import bank_staff, current_user
from app.services import ai
from app.services.views import latest_decision, latest_scoring

router = APIRouter(prefix="/api", tags=["ИИ-помощник"])


class NeedRequest(BaseModel):
    text: str = Field(min_length=3, max_length=1000)


class ParsedNeed(BaseModel):
    purpose: str | None
    amount: int | None
    term_months: int | None
    summary: str | None
    source: str


@router.get("/ai/status", summary="Включены ли ИИ-функции и какая модель")
def ai_status(user: User = Depends(current_user)) -> dict:
    return ai.status()


@router.post("/ai/parse-need", response_model=ParsedNeed, summary="Разобрать описание задачи клиента")
async def parse_need(body: NeedRequest, user: User = Depends(current_user)) -> ParsedNeed:
    return ParsedNeed(**await run_in_threadpool(ai.parse_need, body.text))


_summary_cache: dict[tuple, list[str]] = {}


@router.get("/bank/applications/{application_id}/ai-summary", summary="Сводка досье для аналитика (ИИ)")
def ai_summary(application_id: uuid.UUID, user: User = Depends(bank_staff), db: Session = Depends(get_db)) -> dict:
    if not ai.status()["enabled"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ИИ-функции выключены")
    application = db.get(Application, application_id)
    if application is None or application.status == AppStatus.DRAFT:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заявка не найдена")
    scoring = latest_scoring(db, application)
    decision = latest_decision(db, application)
    key = (application.id, application.run_no, decision.id if decision else None)
    if key not in _summary_cache:
        features = collect_inputs(db, application).to_dict()
        context = {
            "компания": application.company.name,
            "продукт": application.product.name,
            "сумма": float(application.amount),
            "срок_мес": application.term_months,
            "признаки": {k: v for k, v in features.items() if v not in (None, [], 0)},
            "скоринг": {"балл": scoring.score, "класс": scoring.risk_class, "факторы": scoring.factors}
            if scoring
            else None,
            "флаги": [FLAGS.get(code, code) for code in (decision.flags if decision else [])],
            "источники": {code: row.status for code, row in run_results(db, application).items()},
        }
        try:
            _summary_cache[key] = ai.dossier_summary(context)
        except ai.LlmUnavailable as error:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(error)) from None
    return {"points": _summary_cache[key], "model": ai.status()["model"]}
