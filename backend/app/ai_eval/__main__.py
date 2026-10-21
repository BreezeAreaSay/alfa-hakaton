"""Оценка разбора потребности клиента на эталонном наборе фраз.

    python -m app.ai_eval                  # только правила
    python -m app.ai_eval --llm            # правила и модель (AI_ENABLED=true и параметры LLM_*)
    python -m app.ai_eval --llm --out report.md

В режиме --llm вызывается та же функция, что и в API: при сбое модели ответ строится на правилах,
такие случаи считаются отдельно.
"""

import argparse
import json
import statistics
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.domain.text import plural
from app.services import ai

GOLDEN_SET = Path(__file__).with_name("golden_set.json")
FIELDS = ("purpose", "amount", "term_months")
FIELD_LABELS = {"purpose": "Цель", "amount": "Сумма", "term_months": "Срок"}


def load_cases(path: Path = GOLDEN_SET) -> list[dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def evaluate(parse: Callable[[str], dict[str, Any]], cases: list[dict[str, Any]], *, llm: bool) -> dict[str, Any]:
    correct = dict.fromkeys(FIELDS, 0)
    exact = invented = fallbacks = 0
    latencies: list[float] = []
    mistakes: list[dict[str, Any]] = []
    for case in cases:
        started = time.perf_counter()
        result = parse(case["text"])
        latencies.append(time.perf_counter() - started)
        fallbacks += result.get("source") == "rules"
        wrong = {}
        for name in FIELDS:
            if result.get(name) == case[name]:
                correct[name] += 1
            else:
                wrong[name] = {"expected": case[name], "got": result.get(name)}
                invented += name != "purpose" and case[name] is None
        exact += not wrong
        if wrong:
            mistakes.append({"id": case["id"], "text": case["text"], "fields": wrong})
    return {
        "llm": llm,
        "total": len(cases),
        "correct": correct,
        "exact": exact,
        "invented": invented,
        "fallbacks": fallbacks,
        "latency_median": statistics.median(latencies),
        "latency_p95": sorted(latencies)[max(0, round(len(latencies) * 0.95) - 1)],
        "mistakes": mistakes,
    }


def _share(count: int, total: int) -> str:
    return f"{count / total:.0%} ({count}/{total})"


def _seconds(value: float) -> str:
    return "< 1 мс" if value < 0.001 else f"{value:.2f} с"


def render(results: dict[str, dict[str, Any]]) -> str:
    total = next(iter(results.values()))["total"]
    lines = [
        f"Эталонный набор: {total} {plural(total, 'фраза', 'фразы', 'фраз')}",
        "",
        "| Показатель | " + " | ".join(results) + " |",
        "|---|" + "---|" * len(results),
    ]
    rows: list[tuple[str, Callable[[dict[str, Any]], str]]] = [
        *((FIELD_LABELS[name], lambda r, name=name: _share(r["correct"][name], total)) for name in FIELDS),
        ("Все три параметра верно", lambda r: _share(r["exact"], total)),
        ("Придуманные сумма или срок", lambda r: str(r["invented"])),
        ("Ответ на правилах (модель не ответила)", lambda r: str(r["fallbacks"]) if r["llm"] else "—"),
        ("Время ответа: медиана / p95", lambda r: f"{_seconds(r['latency_median'])} / {_seconds(r['latency_p95'])}"),
    ]
    for label, cell in rows:
        lines.append(f"| {label} | " + " | ".join(cell(r) for r in results.values()) + " |")
    for mode, result in results.items():
        if not result["mistakes"]:
            continue
        lines += ["", f"Ошибки — {mode}:", ""]
        for mistake in result["mistakes"]:
            details = ", ".join(
                f"{FIELD_LABELS[name]}: ожидалось {value['expected']}, получено {value['got']}"
                for name, value in mistake["fields"].items()
            )
            lines.append(f"- №{mistake['id']} «{mistake['text']}» — {details}")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Оценка разбора потребности клиента")
    parser.add_argument("--llm", action="store_true", help="оценить и модель (нужны AI_ENABLED=true и LLM_*)")
    parser.add_argument("--out", type=Path, help="сохранить отчёт в файл Markdown")
    args = parser.parse_args()

    cases = load_cases()
    results = {"Правила": evaluate(ai.parse_need_rules, cases, llm=False)}
    if args.llm:
        settings = get_settings()
        if not settings.ai_enabled:
            parser.error("ИИ выключен: задайте AI_ENABLED=true и параметры LLM_BASE_URL, LLM_MODEL, LLM_API_KEY")
        results[f"Модель {settings.llm_model}"] = evaluate(ai.parse_need, cases, llm=True)
    report = render(results)
    print(report)
    if args.out:
        args.out.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
