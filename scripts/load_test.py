"""Нагрузочная проверка стенда: время ответа API и пропускная способность конвейера.

Запуск на поднятом стенде (из каталога backend — там есть httpx):

    cd backend && uv run python ../scripts/load_test.py --api http://localhost:8080

1. Кабинет и рабочее место: --users параллельных пользователей отправляют --requests запросов вперемешку —
   каталог, расчёт условий, список и карточка заявки, уведомления, очередь и досье аналитика.
2. Конвейер: --applications заявок отправляются одновременно, для каждой замеряется время от отправки до решения.

Скрипт создаёт заявки, поэтому после проверки сбросьте демо-данные: make reset.
"""

import argparse
import asyncio
import random
import statistics
import time
import uuid
from collections import defaultdict

import httpx

CLIENTS = ["veter", "smirnova", "tehnomaster", "vektor", "grand", "altair"]
PIPELINE_CLIENTS = ["veter", "altair"]  # автоодобрение: решение без аналитика
PROCESSING = {"SUBMITTED", "IN_PROCESSING", "ACCEPTED", "SIGNED"}


def percentile(values: list[float], share: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(share * (len(ordered) - 1)))]


def describe(values: list[float]) -> str:
    return (
        f"минимум {min(values):.0f} мс, медиана {statistics.median(values):.0f} мс, "
        f"95% {percentile(values, 0.95):.0f} мс, 99% {percentile(values, 0.99):.0f} мс, максимум {max(values):.0f} мс"
    )


async def login(http: httpx.AsyncClient, user: str) -> dict[str, str]:
    response = await http.post("/api/auth/login", json={"login": user, "password": "demo"})
    response.raise_for_status()
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def api_load(http: httpx.AsyncClient, users: int, total: int) -> None:
    clients = {name: await login(http, name) for name in CLIENTS}
    analyst = await login(http, "analyst")
    queue = (await http.get("/api/bank/applications", headers=analyst)).json()
    own: dict[str, list[str]] = {}
    for name, headers in clients.items():
        own[name] = [item["id"] for item in (await http.get("/api/applications", headers=headers)).json()]

    def pick() -> tuple[str, str, dict, dict | None]:
        name = random.choice(CLIENTS)
        headers = clients[name]
        roll = random.random()
        if roll < 0.15:
            return "GET /api/products", "/api/products", headers, None
        if roll < 0.35:
            body = {
                "purpose": random.choice(["WORKING_CAPITAL", "CASH_GAP", "EQUIPMENT", "EXPANSION"]),
                "amount": random.choice([500_000, 1_500_000, 3_000_000, 12_000_000]),
                "term_months": random.choice([12, 24, 36]),
            }
            return "POST /api/calculator/quote", "/api/calculator/quote", headers, body
        if roll < 0.5:
            return "GET /api/applications", "/api/applications", headers, None
        if roll < 0.65 and own[name]:
            return "GET /api/applications/{id}", f"/api/applications/{random.choice(own[name])}", headers, None
        if roll < 0.8:
            return "GET /api/notifications", "/api/notifications", headers, None
        if roll < 0.9 or not queue:
            return "GET /api/bank/applications", "/api/bank/applications", analyst, None
        item = random.choice(queue)
        return "GET /api/bank/applications/{id}/dossier", f"/api/bank/applications/{item['id']}/dossier", analyst, None

    timings: dict[str, list[float]] = defaultdict(list)
    errors = 0
    left = total

    async def worker() -> None:
        nonlocal errors, left
        while left > 0:
            left -= 1
            label, url, headers, body = pick()
            started = time.perf_counter()
            if body is None:
                response = await http.get(url, headers=headers)
            else:
                response = await http.post(url, headers=headers, json=body)
            timings[label].append((time.perf_counter() - started) * 1000)
            if response.status_code >= 400:
                errors += 1

    started = time.perf_counter()
    await asyncio.gather(*(worker() for _ in range(users)))
    elapsed = time.perf_counter() - started
    everything = [value for values in timings.values() for value in values]
    print(f"\n1. Кабинет и рабочее место: {users} параллельных пользователей, {len(everything)} запросов")
    print(f"   {len(everything) / elapsed:.0f} запросов в секунду, ошибок: {errors}")
    print(f"   все запросы: {describe(everything)}")
    for label, values in sorted(timings.items()):
        print(f"   {label}: {describe(values)}")


async def submit_and_wait(http: httpx.AsyncClient, headers: dict[str, str], timeout: float) -> tuple[float, str]:
    body = {"product_code": "GROWTH", "purpose": "WORKING_CAPITAL", "amount": 3_000_000, "term_months": 24}
    draft = (await http.post("/api/applications", headers=headers, json=body)).json()
    started = time.perf_counter()
    response = await http.post(
        f"/api/applications/{draft['id']}/submit",
        headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
        json={"consent_bki": True, "consent_pd": True},
    )
    response.raise_for_status()
    while True:
        application = (await http.get(f"/api/applications/{draft['id']}", headers=headers)).json()
        if application["status"] not in PROCESSING:
            return (time.perf_counter() - started) * 1000, application["status"]
        if time.perf_counter() - started > timeout:
            return (time.perf_counter() - started) * 1000, "TIMEOUT"
        await asyncio.sleep(0.25)


async def pipeline_load(http: httpx.AsyncClient, count: int, timeout: float) -> None:
    sessions = [await login(http, name) for name in PIPELINE_CLIENTS]
    started = time.perf_counter()
    results = await asyncio.gather(
        *(submit_and_wait(http, sessions[index % len(sessions)], timeout) for index in range(count))
    )
    elapsed = time.perf_counter() - started
    durations = [duration for duration, _ in results]
    statuses: dict[str, int] = defaultdict(int)
    for _, status in results:
        statuses[status] += 1
    print(f"\n2. Конвейер: {count} заявок отправлены одновременно")
    print(f"   все решения за {elapsed:.1f} с — {count / elapsed * 60:.0f} заявок в минуту")
    print(f"   от отправки до решения: {describe(durations)}")
    print("   статусы: " + ", ".join(f"{status} — {number}" for status, number in sorted(statuses.items())))


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://localhost:8080")
    parser.add_argument("--users", type=int, default=20, help="параллельных пользователей в сценарии 1")
    parser.add_argument("--requests", type=int, default=2000, help="запросов в сценарии 1")
    parser.add_argument("--applications", type=int, default=30, help="заявок в сценарии 2, 0 — пропустить")
    parser.add_argument("--timeout", type=float, default=300, help="сколько ждать решения по заявке, секунд")
    args = parser.parse_args()
    limits = httpx.Limits(max_connections=args.users + args.applications + 10)
    async with httpx.AsyncClient(base_url=args.api, timeout=60, limits=limits) as http:
        await api_load(http, args.users, args.requests)
        if args.applications:
            await pipeline_load(http, args.applications, args.timeout)


if __name__ == "__main__":
    asyncio.run(main())
