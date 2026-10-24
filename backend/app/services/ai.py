"""ИИ-помощник (необязательный): разбор потребности клиента и сводка досье для аналитика.

Модель подключается через API в формате OpenAI: локальная Ollama или другой сервис с открытыми весами.
Если ИИ выключен или не ответил, подбор работает на правилах — основной сценарий от модели не зависит.
Кредитное решение модель не принимает.
"""

import json
import logging
import re
from decimal import Decimal
from typing import Any

import httpx

from app.config import get_settings
from app.domain.enums import Purpose

log = logging.getLogger("ai")

PURPOSE_KEYWORDS: dict[str, tuple[str, ...]] = {
    Purpose.EQUIPMENT: (
        "оборудован",
        "станок",
        "станк",
        "транспорт",
        "машин",
        "грузовик",
        "автомоб",
        "техник",
        "фургон",
        "трактор",
        "погрузчик",
        "печь",
        "кофемашин",
        "автопарк",
    ),
    Purpose.CASH_GAP: (
        "разрыв",
        "поставщик",
        "зарплат",
        "налог",
        "аренд",
        "задерж",
        "отсрочк",
        "покупател",
        "дебитор",
        "оплатить счет",
        "оплатить счёт",
        "не хватает",
        "пока не заплат",
    ),
    Purpose.EXPANSION: (
        "расшир",
        "откры",
        "точк",
        "филиал",
        "магазин",
        "новую",
        "новое",
        "цех",
        "склад",
        "помещени",
        "ремонт",
        "франшиз",
    ),
    Purpose.WORKING_CAPITAL: ("закуп", "товар", "сырь", "материал", "оборот", "сезон", "запас", "партию", "партия"),
}

NUMBER_WORDS = {
    "один": 1,
    "одну": 1,
    "два": 2,
    "две": 2,
    "три": 3,
    "четыре": 4,
    "пять": 5,
    "шесть": 6,
    "семь": 7,
    "восемь": 8,
    "девять": 9,
    "десять": 10,
    "полтора": 1.5,
    "полторы": 1.5,
}

AMOUNT_RE = re.compile(
    r"(\d{1,3}(?:[\s ]\d{3})+|\d+(?:[.,]\d+)?|полтора|полторы|один|два|три|пять|десять)\s*"
    r"(млн|миллион\w*|мл|м\b|тыс\w*|т\.?\s?р|к\b|руб\w*|₽|р\b)?",
    re.IGNORECASE,
)
TERM_RE = re.compile(
    r"(?:на|за|через|срок\w*)\s+(\d+(?:[.,]\d+)?|полгода|год|полтора|полторы|один|одну|два|две|три|четыре|пять|шесть|десять)"
    r"\s*(лет|года|год|мес\w*)?",
    re.IGNORECASE,
)


def _number(token: str) -> float | None:
    token = token.lower().replace(" ", " ").strip()
    if token in NUMBER_WORDS:
        return float(NUMBER_WORDS[token])
    try:
        return float(token.replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def parse_amount(text: str) -> int | None:
    best = None
    for match in AMOUNT_RE.finditer(text):
        value = _number(match.group(1))
        unit = (match.group(2) or "").lower()
        if value is None:
            continue
        if unit.startswith(("млн", "миллион", "мл")) or unit == "м":
            value *= 1_000_000
        elif unit.startswith(("тыс", "т")) or unit == "к":
            value *= 1_000
        elif not unit and value < 1000:
            continue  # голое маленькое число — скорее срок или количество, не сумма
        if value >= 10_000 and (best is None or value > best):
            best = value
    if best is None and re.search(r"\bмиллион\b", text, re.IGNORECASE):
        best = 1_000_000  # «нужен миллион»
    return int(best) if best else None


def parse_term(text: str) -> int | None:
    lowered = text.lower()
    if "полгода" in lowered or "пол года" in lowered:
        return 6
    for match in TERM_RE.finditer(lowered):
        raw, unit = match.group(1), (match.group(2) or "")
        if raw == "полгода":
            return 6
        if raw == "год" and not unit:
            return 12
        value = _number(raw)
        if value is None:
            continue
        if unit.startswith("мес"):
            return int(value)
        if unit in ("лет", "года", "год"):
            return int(value * 12)
    return None


def parse_purpose(text: str) -> str | None:
    lowered = text.lower()
    scores = {purpose: sum(lowered.count(word) for word in words) for purpose, words in PURPOSE_KEYWORDS.items()}
    purpose, score = max(scores.items(), key=lambda item: item[1])
    return purpose if score > 0 else None


def parse_need_rules(text: str) -> dict[str, Any]:
    return {
        "purpose": parse_purpose(text),
        "amount": parse_amount(text),
        "term_months": parse_term(text),
        "summary": None,
        "source": "rules",
    }


SYSTEM_PROMPT = (
    "Ты помогаешь предпринимателю оформить кредит для бизнеса. Из описания задачи извлеки параметры. "
    "Отвечай только JSON без пояснений: "
    '{"purpose": "WORKING_CAPITAL" | "CASH_GAP" | "EQUIPMENT" | "EXPANSION" | null, '
    '"amount": число в рублях или null, "term_months": целое число месяцев или null, '
    '"summary": "цель кредита одной фразой на русском"}. '
    "WORKING_CAPITAL — закупка товара, сырья, пополнение оборотных средств; CASH_GAP — кассовый разрыв, "
    "оплата поставщикам, зарплаты и налоги, пока не пришли деньги от покупателей; EQUIPMENT — покупка "
    "оборудования, транспорта, техники; EXPANSION — новая точка, филиал, расширение, ремонт помещения. "
    "Если параметр не указан — null. Не придумывай суммы и сроки."
)


class LlmUnavailable(Exception):
    pass


def chat(messages: list[dict[str, str]], *, json_mode: bool = False, max_tokens: int = 400) -> str:
    settings = get_settings()
    if not settings.ai_enabled:
        raise LlmUnavailable("ИИ выключен")
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"} if settings.llm_api_key else {}
    payload: dict[str, Any] = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    url = f"{settings.llm_base_url.rstrip('/')}/chat/completions"
    try:
        response = httpx.post(url, json=payload, headers=headers, timeout=settings.llm_timeout_seconds)
        if response.status_code == 400 and json_mode:
            # Не каждый сервис с API в формате OpenAI принимает response_format (часть моделей у провайдеров,
            # старые сборки vLLM). Повторяем без него: JSON всё равно извлекается из текста ответа
            payload.pop("response_format")
            response = httpx.post(url, json=payload, headers=headers, timeout=settings.llm_timeout_seconds)
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"] or ""
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as error:
        raise LlmUnavailable(f"Модель недоступна: {error.__class__.__name__}") from None
    return re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()


def _extract_json(text: str) -> dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("нет JSON в ответе")
    return json.loads(text[start : end + 1])


def parse_need(text: str) -> dict[str, Any]:
    rules = parse_need_rules(text)
    try:
        raw = chat(
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": f"{text}\n/no_think"}],
            json_mode=True,
        )
        data = _extract_json(raw)
    except (LlmUnavailable, ValueError) as error:
        log.info("Разбор потребности на правилах: %s", error)
        return rules
    purpose = data.get("purpose") if data.get("purpose") in {p.value for p in Purpose} else None
    amount = data.get("amount")
    term = data.get("term_months")
    amount = int(Decimal(str(amount))) if isinstance(amount, (int, float)) and 10_000 <= amount <= 1e10 else None
    term = int(term) if isinstance(term, (int, float)) and 1 <= term <= 240 else None
    summary = data.get("summary") if isinstance(data.get("summary"), str) else None
    return {
        "purpose": purpose or rules["purpose"],
        "amount": amount or rules["amount"],
        "term_months": term or rules["term_months"],
        "summary": summary[:300] if summary else None,
        "source": "llm",
    }


SUMMARY_PROMPT = (
    "Ты помогаешь кредитному аналитику банка. По данным досье выдели сильные стороны и риски заявки. "
    'Отвечай только JSON без пояснений: {"strengths": ["…"], "risks": ["…"]} — всего 3–5 коротких пунктов '
    "на русском. Используй только факты из данных, не придумывай цифры. Не принимай решение за аналитика."
)


def _items(value: Any) -> list[str]:
    return [item.strip() for item in value if isinstance(item, str) and item.strip()] if isinstance(value, list) else []


def summary_points(raw: str) -> list[str]:
    """Пункты сводки: «+ » — сильная сторона, «− » — риск."""
    try:
        data = _extract_json(raw)
        points = [f"+ {item}" for item in _items(data.get("strengths"))]
        points += [f"− {item}" for item in _items(data.get("risks"))]
    except ValueError:
        # модель ответила текстом: берём строки как есть, тире в начале считаем пометкой риска
        lines = [line.strip(" •*\t") for line in raw.splitlines()]
        points = [re.sub(r"^[–-]\s+", "− ", line) for line in lines if len(line) > 3]
    return points[:6]


def dossier_summary(context: dict[str, Any]) -> list[str]:
    raw = chat(
        [
            {"role": "system", "content": SUMMARY_PROMPT},
            {"role": "user", "content": json.dumps(context, ensure_ascii=False, default=str) + "\n/no_think"},
        ],
        json_mode=True,
        max_tokens=500,
    )
    points = summary_points(raw)
    if not points:
        raise LlmUnavailable("Модель не вернула сводку")
    return points


def status() -> dict[str, Any]:
    settings = get_settings()
    return {
        "enabled": settings.ai_enabled,
        "model": settings.llm_model if settings.ai_enabled else None,
        "mode": "llm" if settings.ai_enabled else "rules",
    }
