// Разбор выписки по расчётному счёту (формат обмена 1С и CSV) — порт backend/app/services/statements.py.
import type { StatementSummary } from '../../api/types';
import { forecast } from './cashflow';

export class StatementError extends Error {}

function decode(raw: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
        // не UTF-8 — выгрузки 1С обычно в кодировке Windows-1251
    }
    try {
        return new TextDecoder('windows-1251', { fatal: true }).decode(raw);
    } catch {
        throw new StatementError('Не удалось прочитать файл: неизвестная кодировка');
    }
}

function validDate(y: number, m: number, d: number): boolean {
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseDay(value: string): string {
    const text = value.trim();
    let match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
    let parts: [number, number, number] | null = match ? [Number(match[3]), Number(match[2]), Number(match[1])] : null;
    if (!parts) {
        match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
        parts = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    }
    if (!parts || !validDate(...parts)) throw new StatementError(`Не удалось разобрать дату «${text}»`);
    const [y, m, d] = parts;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Сумма в копейках: десятичная арифметика, как Decimal на сервере. */
function parseCents(value: string): number {
    const text = value.trim().replaceAll(' ', '').replaceAll(String.fromCharCode(0xa0), '').replaceAll(',', '.');
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) throw new StatementError(`Не удалось разобрать сумму «${value}»`);
    return Math.round(Number(text) * 100);
}

type Row = [string, number, number];

function summary(
    rows: Row[],
    source: string,
    account: string | null,
    closingBalance: number | null = null,
): StatementSummary {
    if (!rows.length) throw new StatementError('В выписке нет операций');
    const inflow = new Map<string, number>();
    const outflow = new Map<string, number>();
    for (const [day, amountIn, amountOut] of rows) {
        const key = day.slice(0, 7);
        inflow.set(key, (inflow.get(key) ?? 0) + amountIn);
        outflow.set(key, (outflow.get(key) ?? 0) + amountOut);
    }
    const months = [...new Set([...inflow.keys(), ...outflow.keys()])].sort().slice(-12);
    const totalIn = months.reduce((sum, m) => sum + (inflow.get(m) ?? 0), 0);
    const days = rows.map((r) => r[0]).sort();
    const monthly = months.map((m) => ({
        month: m,
        inflow: (inflow.get(m) ?? 0) / 100,
        outflow: (outflow.get(m) ?? 0) / 100,
    }));
    return {
        source,
        account,
        period_from: days[0],
        period_to: days[days.length - 1],
        operations: rows.length,
        months: monthly,
        total_inflow: totalIn / 100,
        avg_monthly_inflow: totalIn / (100 * months.length),
        closing_balance: closingBalance,
        forecast: forecast(monthly, closingBalance),
    };
}

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

export function parse1c(text: string): StatementSummary {
    if (!text.trimStart().startsWith('1CClientBankExchange')) throw new StatementError('Это не файл обмена 1С');
    let account: string | null = null;
    let closingBalance: number | null = null;
    const rows: Row[] = [];
    let document: Record<string, string> | null = null;
    for (const rawLine of text.split(LINE_BREAK)) {
        const line = rawLine.trim();
        if (!line || (!line.includes('=') && !line.startsWith('Конец'))) continue;
        if (line.startsWith('СекцияДокумент')) {
            document = {};
            continue;
        }
        if (line === 'КонецДокумента') {
            if (document !== null && account) {
                const amount = parseCents(document['Сумма'] ?? '0');
                const day = parseDay(document['ДатаПоступило'] || document['ДатаСписано'] || document['Дата'] || '');
                if (document['ПолучательСчет'] === account) rows.push([day, amount, 0]);
                else if (document['ПлательщикСчет'] === account) rows.push([day, 0, amount]);
            }
            document = null;
            continue;
        }
        const index = line.indexOf('=');
        const key = index >= 0 ? line.slice(0, index) : line;
        const value = index >= 0 ? line.slice(index + 1) : '';
        if (document !== null) document[key] = value;
        else if (key === 'РасчСчет') account = value;
        else if (key === 'КонечныйОстаток') closingBalance = parseCents(value) / 100;
    }
    if (!account) throw new StatementError('В файле не указан расчётный счёт (РасчСчет)');
    return summary(rows, '1C', account, closingBalance);
}

/** Строки CSV с кавычками — как csv.reader в Python. */
function csvRows(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    let started = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else quoted = false;
            } else field += ch;
            continue;
        }
        if (ch === '"' && !field) {
            quoted = true;
            started = true;
        } else if (ch === delimiter) {
            row.push(field);
            field = '';
            started = true;
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
            if (started || field) row.push(field);
            rows.push(row);
            row = [];
            field = '';
            started = false;
        } else {
            field += ch;
            started = true;
        }
    }
    if (started || field) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

export function parseCsv(text: string): StatementSummary {
    const sample = text.slice(0, 2048);
    const delimiter = sample.split(';').length >= sample.split(',').length ? ';' : ',';
    const [header = [], ...records] = csvRows(text, delimiter);
    const fields = new Map(header.map((name, index) => [name.toLowerCase().trim(), index]));
    if (!['дата', 'приход', 'расход'].every((name) => fields.has(name))) {
        throw new StatementError('В CSV нужны колонки: Дата; Приход; Расход');
    }
    const rows: Row[] = [];
    for (const record of records) {
        if (!record.length) continue; // пустые строки DictReader пропускает
        const cell = (name: string) => record[fields.get(name) as number] ?? null;
        rows.push([parseDay(cell('дата') ?? ''), parseCents(cell('приход') || '0'), parseCents(cell('расход') || '0')]);
    }
    return summary(rows, 'CSV', null);
}

export function parseStatement(fileName: string, raw: Uint8Array): StatementSummary {
    const text = decode(raw);
    if (text.trimStart().startsWith('1CClientBankExchange')) return parse1c(text);
    if (fileName.toLowerCase().endsWith('.csv')) return parseCsv(text);
    throw new StatementError('Поддерживаются выписки в формате 1С (.txt) и CSV');
}
