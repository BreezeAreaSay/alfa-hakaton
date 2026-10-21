// Разбор описания задачи клиента на правилах — порт parse_amount, parse_term и parse_purpose
// из backend/app/services/ai.py. Регулярные выражения повторяют серверные с поправкой на JS:
// \w и \b в Python понимают кириллицу, поэтому здесь они заменены классами букв Юникода.
import type { ParsedNeed, Purpose } from '../../api/types';

const PURPOSE_KEYWORDS: [Purpose, string[]][] = [
    [
        'EQUIPMENT',
        [
            'оборудован',
            'станок',
            'станк',
            'транспорт',
            'машин',
            'грузовик',
            'автомоб',
            'техник',
            'фургон',
            'трактор',
            'погрузчик',
            'печь',
            'кофемашин',
            'автопарк',
        ],
    ],
    [
        'CASH_GAP',
        [
            'разрыв',
            'поставщик',
            'зарплат',
            'налог',
            'аренд',
            'задерж',
            'отсрочк',
            'покупател',
            'дебитор',
            'оплатить счет',
            'оплатить счёт',
            'не хватает',
            'пока не заплат',
        ],
    ],
    [
        'EXPANSION',
        [
            'расшир',
            'откры',
            'точк',
            'филиал',
            'магазин',
            'новую',
            'новое',
            'цех',
            'склад',
            'помещени',
            'ремонт',
            'франшиз',
        ],
    ],
    ['WORKING_CAPITAL', ['закуп', 'товар', 'сырь', 'материал', 'оборот', 'сезон', 'запас', 'партию', 'партия']],
];

const NUMBER_WORDS: Record<string, number> = {
    один: 1,
    одну: 1,
    два: 2,
    две: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
    десять: 10,
    полтора: 1.5,
    полторы: 1.5,
};

// \w и \b в смысле Python: буквы и цифры любого алфавита и знак подчёркивания
const W = '[\\p{L}\\p{N}_]';
const END = `(?!${W})`;

const AMOUNT_RE = new RegExp(
    '(\\d{1,3}(?:[\\s\\u00a0]\\d{3})+|\\d+(?:[.,]\\d+)?|полтора|полторы|один|два|три|пять|десять)\\s*' +
        `(млн|миллион${W}*|мл|м${END}|тыс${W}*|т\\.?\\s?р|к${END}|руб${W}*|₽|р${END})?`,
    'giu',
);
const TERM_RE = new RegExp(
    `(?:на|за|через|срок${W}*)\\s+(\\d+(?:[.,]\\d+)?|полгода|год|полтора|полторы|один|одну|два|две|три|четыре|пять|шесть|десять)` +
        `\\s*(лет|года|год|мес${W}*)?`,
    'giu',
);
const MILLION_RE = new RegExp(`(?<!${W})миллион${END}`, 'iu');

// float() в Python: число с необязательной дробной частью и экспонентой, без мусора вокруг
const FLOAT_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

function toNumber(token: string): number | null {
    const cleaned = token.toLowerCase().replaceAll('\u00a0', ' ').trim();
    if (Object.hasOwn(NUMBER_WORDS, cleaned)) return NUMBER_WORDS[cleaned];
    const plain = cleaned.replaceAll(' ', '').replaceAll(',', '.');
    return FLOAT_RE.test(plain) ? Number(plain) : null;
}

export function parseAmount(text: string): number | null {
    let best: number | null = null;
    for (const match of text.matchAll(AMOUNT_RE)) {
        let value = toNumber(match[1]);
        const unit = (match[2] ?? '').toLowerCase();
        if (value === null) continue;
        if (unit.startsWith('млн') || unit.startsWith('миллион') || unit.startsWith('мл') || unit === 'м') {
            value *= 1_000_000;
        } else if (unit.startsWith('тыс') || unit.startsWith('т') || unit === 'к') {
            value *= 1_000;
        } else if (!unit && value < 1000) {
            continue; // голое маленькое число — скорее срок или количество, не сумма
        }
        if (value >= 10_000 && (best === null || value > best)) best = value;
    }
    if (best === null && MILLION_RE.test(text)) best = 1_000_000; // «нужен миллион»
    return best ? Math.trunc(best) : null;
}

export function parseTerm(text: string): number | null {
    const lowered = text.toLowerCase();
    if (lowered.includes('полгода') || lowered.includes('пол года')) return 6;
    for (const match of lowered.matchAll(TERM_RE)) {
        const raw = match[1];
        const unit = match[2] ?? '';
        if (raw === 'полгода') return 6;
        if (raw === 'год' && !unit) return 12;
        const value = toNumber(raw);
        if (value === null) continue;
        if (unit.startsWith('мес')) return Math.trunc(value);
        if (unit === 'лет' || unit === 'года' || unit === 'год') return Math.trunc(value * 12);
    }
    return null;
}

const count = (text: string, word: string): number => text.split(word).length - 1;

export function parsePurpose(text: string): Purpose | null {
    const lowered = text.toLowerCase();
    let best: Purpose | null = null;
    let bestScore = 0;
    for (const [purpose, words] of PURPOSE_KEYWORDS) {
        const value = words.reduce((sum, word) => sum + count(lowered, word), 0);
        if (value > bestScore) {
            best = purpose;
            bestScore = value;
        }
    }
    return best;
}

export function parseNeedRules(text: string): ParsedNeed {
    return {
        purpose: parsePurpose(text),
        amount: parseAmount(text),
        term_months: parseTerm(text),
        summary: null,
        source: 'rules',
    };
}
