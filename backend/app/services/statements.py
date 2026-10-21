"""Разбор выписки по расчётному счёту: формат обмена 1С (1CClientBankExchange) и CSV.

Результат — помесячные поступления и списания. По ним оценивается выручка, если нет отчётности
и клиент не обслуживается в банке.
"""

import csv
import io
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any


class StatementError(ValueError):
    pass


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise StatementError("Не удалось прочитать файл: неизвестная кодировка")


def _parse_date(value: str) -> date:
    value = value.strip()
    for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise StatementError(f"Не удалось разобрать дату «{value}»")


def _parse_amount(value: str) -> Decimal:
    try:
        return Decimal(value.strip().replace(" ", "").replace(" ", "").replace(",", "."))
    except InvalidOperation:
        raise StatementError(f"Не удалось разобрать сумму «{value}»") from None


def _summary(rows: list[tuple[date, Decimal, Decimal]], source: str, account: str | None) -> dict[str, Any]:
    if not rows:
        raise StatementError("В выписке нет операций")
    inflow: dict[str, Decimal] = defaultdict(Decimal)
    outflow: dict[str, Decimal] = defaultdict(Decimal)
    for day, amount_in, amount_out in rows:
        key = day.strftime("%Y-%m")
        inflow[key] += amount_in
        outflow[key] += amount_out
    months = sorted(set(inflow) | set(outflow))[-12:]
    total_in = sum(inflow[m] for m in months)
    return {
        "source": source,
        "account": account,
        "period_from": min(r[0] for r in rows).isoformat(),
        "period_to": max(r[0] for r in rows).isoformat(),
        "operations": len(rows),
        "months": [{"month": m, "inflow": float(inflow[m]), "outflow": float(outflow[m])} for m in months],
        "total_inflow": float(total_in),
        "avg_monthly_inflow": float(total_in / len(months)),
    }


def parse_1c(text: str) -> dict[str, Any]:
    if not text.lstrip().startswith("1CClientBankExchange"):
        raise StatementError("Это не файл обмена 1С")
    account = None
    rows: list[tuple[date, Decimal, Decimal]] = []
    document: dict[str, str] | None = None
    for line in text.splitlines():
        line = line.strip()
        if not line or "=" not in line and not line.startswith("Конец"):
            continue
        if line.startswith("СекцияДокумент"):
            document = {}
            continue
        if line == "КонецДокумента":
            if document is not None and account:
                amount = _parse_amount(document.get("Сумма", "0"))
                day = _parse_date(
                    document.get("ДатаПоступило") or document.get("ДатаСписано") or document.get("Дата", "")
                )
                if document.get("ПолучательСчет") == account:
                    rows.append((day, amount, Decimal(0)))
                elif document.get("ПлательщикСчет") == account:
                    rows.append((day, Decimal(0), amount))
            document = None
            continue
        key, _, value = line.partition("=")
        if document is not None:
            document[key] = value
        elif key == "РасчСчет":
            account = value
    if not account:
        raise StatementError("В файле не указан расчётный счёт (РасчСчет)")
    return _summary(rows, "1C", account)


def parse_csv(text: str) -> dict[str, Any]:
    sample = text[:2048]
    delimiter = ";" if sample.count(";") >= sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    fields = {name.lower().strip(): name for name in reader.fieldnames or []}
    required = {"дата", "приход", "расход"}
    if not required <= set(fields):
        raise StatementError("В CSV нужны колонки: Дата; Приход; Расход")
    rows = []
    for record in reader:
        day = _parse_date(record[fields["дата"]])
        amount_in = _parse_amount(record[fields["приход"]] or "0")
        amount_out = _parse_amount(record[fields["расход"]] or "0")
        rows.append((day, amount_in, amount_out))
    return _summary(rows, "CSV", None)


def parse_statement(file_name: str, raw: bytes) -> dict[str, Any]:
    text = _decode(raw)
    if text.lstrip().startswith("1CClientBankExchange"):
        return parse_1c(text)
    if file_name.lower().endswith(".csv"):
        return parse_csv(text)
    raise StatementError("Поддерживаются выписки в формате 1С (.txt) и CSV")
