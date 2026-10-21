"""ИИ-функции (необязательные). Основной сценарий работает без них."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/ai", tags=["ИИ-помощник"])
