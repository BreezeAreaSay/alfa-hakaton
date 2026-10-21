"""Работа с моделью без сети: ответ модели подменяется."""

import json

import httpx
import pytest

from app.config import get_settings
from app.services import ai

TEXT = "Нужно 300 тысяч на закупку материалов для производства на полгода"


@pytest.fixture
def llm(monkeypatch):
    """Включает ИИ и подменяет ответ модели. Возвращает список отправленных запросов."""
    settings = get_settings().model_copy(update={"ai_enabled": True, "llm_model": "test-model"})
    monkeypatch.setattr(ai, "get_settings", lambda: settings)
    sent: list[dict] = []
    answer: dict = {"content": "", "error": None}

    def fake_post(url, json=None, headers=None, timeout=None):  # noqa: A002 — как у httpx.post
        sent.append(json)
        if answer["error"]:
            raise answer["error"]
        body = {"choices": [{"message": {"content": answer["content"]}}]}
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr(ai.httpx, "post", fake_post)

    def reply(content: str = "", error: Exception | None = None) -> list[dict]:
        answer.update(content=content, error=error)
        return sent

    return reply


def test_model_answer_is_used(llm):
    sent = llm(
        '<think>рассуждения</think>{"purpose": "EQUIPMENT", "amount": 7500000, "term_months": 60, '
        '"summary": "Покупка экскаватора"}'
    )
    result = ai.parse_need("Планируем купить экскаватор за 7.5 млн, кредит на 60 месяцев")
    assert result == {
        "purpose": "EQUIPMENT",
        "amount": 7_500_000,
        "term_months": 60,
        "summary": "Покупка экскаватора",
        "source": "llm",
    }
    assert sent[0]["model"] == "test-model"
    assert sent[0]["response_format"] == {"type": "json_object"}


def test_invalid_model_values_are_replaced_by_rules(llm):
    llm(json.dumps({"purpose": "LOTTERY", "amount": 5, "term_months": 999, "summary": None}))
    result = ai.parse_need(TEXT)
    assert (result["purpose"], result["amount"], result["term_months"]) == ("WORKING_CAPITAL", 300_000, 6)
    assert result["source"] == "llm"


@pytest.mark.parametrize("answer", ["не знаю", "{сломанный json"])
def test_unparseable_answer_falls_back_to_rules(llm, answer):
    llm(answer)
    assert ai.parse_need(TEXT) == ai.parse_need_rules(TEXT)


def test_unavailable_model_falls_back_to_rules(llm):
    llm(error=httpx.ConnectTimeout("timeout"))
    assert ai.parse_need(TEXT)["source"] == "rules"


def test_disabled_ai_does_not_call_model(monkeypatch):
    settings = get_settings().model_copy(update={"ai_enabled": False})
    monkeypatch.setattr(ai, "get_settings", lambda: settings)
    monkeypatch.setattr(ai.httpx, "post", lambda *a, **k: pytest.fail("модель не должна вызываться"))
    assert ai.parse_need(TEXT)["source"] == "rules"


def test_dossier_summary_marks_strengths_and_risks(llm):
    llm(json.dumps({"strengths": ["Выручка растёт 3 года подряд"], "risks": ["Высокая долговая нагрузка", ""]}))
    assert ai.dossier_summary({"компания": "ООО «Тест»"}) == [
        "+ Выручка растёт 3 года подряд",
        "− Высокая долговая нагрузка",
    ]


def test_summary_from_plain_text_keeps_risk_marks():
    assert ai.summary_points("+ Нет просрочек\n- Короткая история\n• Отрасль со средним риском") == [
        "+ Нет просрочек",
        "− Короткая история",
        "Отрасль со средним риском",
    ]


def test_empty_summary_is_an_error(llm):
    llm('{"strengths": [], "risks": []}')
    with pytest.raises(ai.LlmUnavailable):
        ai.dossier_summary({})
