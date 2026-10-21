"""Качество разбора на правилах по эталонному набору: защита от регрессий при правке ключевых слов."""

from app.ai_eval.__main__ import evaluate, load_cases
from app.services.ai import parse_need_rules


def test_rules_quality_on_golden_set():
    result = evaluate(parse_need_rules, load_cases(), llm=False)
    total = result["total"]
    assert total >= 30
    assert result["correct"]["purpose"] / total >= 0.9
    assert result["correct"]["amount"] / total >= 0.95
    assert result["correct"]["term_months"] / total >= 0.9
    assert result["exact"] / total >= 0.9


def test_rules_never_invent_amount_or_term():
    assert evaluate(parse_need_rules, load_cases(), llm=False)["invented"] == 0
