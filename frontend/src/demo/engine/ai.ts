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

/** Найденное значение и фрагмент текста, из которого оно взято, — фрагмент показываем клиенту. */
type Found = { value: number; fragment: string };

function findAmount(text: string): Found | null {
    let best: Found | null = null;
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
        if (value >= 10_000 && (best === null || value > best.value)) best = { value, fragment: match[0].trim() };
    }
    if (best === null && MILLION_RE.test(text)) best = { value: 1_000_000, fragment: 'миллион' }; // «нужен миллион»
    return best ? { value: Math.trunc(best.value), fragment: best.fragment } : null;
}

function findTerm(text: string): Found | null {
    const lowered = text.toLowerCase();
    if (lowered.includes('полгода')) return { value: 6, fragment: 'полгода' };
    if (lowered.includes('пол года')) return { value: 6, fragment: 'пол года' };
    for (const match of lowered.matchAll(TERM_RE)) {
        const raw = match[1];
        const unit = match[2] ?? '';
        const fragment = match[0].trim();
        if (raw === 'полгода') return { value: 6, fragment };
        if (raw === 'год' && !unit) return { value: 12, fragment };
        const value = toNumber(raw);
        if (value === null) continue;
        if (unit.startsWith('мес')) return { value: Math.trunc(value), fragment };
        if (unit === 'лет' || unit === 'года' || unit === 'год') return { value: Math.trunc(value * 12), fragment };
    }
    return null;
}

export function parseAmount(text: string): number | null {
    return findAmount(text)?.value ?? null;
}

export function parseTerm(text: string): number | null {
    return findTerm(text)?.value ?? null;
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

export interface NeedEvidence {
    /** Слова из текста, по которым определена цель */
    purpose: string[];
    amount: string | null;
    term: string | null;
}

/**
 * На каких словах основан разбор на правилах — кабинет показывает это клиенту рядом с результатом.
 * Те же словарь и регулярные выражения, что в parseNeedRules, поэтому объяснение совпадает с результатом.
 */
export function explainNeed(text: string): NeedEvidence {
    const lowered = text.toLowerCase();
    const purpose = parsePurpose(text);
    const stems = PURPOSE_KEYWORDS.find(([code]) => code === purpose)?.[1] ?? [];
    const words = [
        // словосочетания показываем как есть, однословные основы — целым словом из текста
        ...stems.filter((stem) => stem.includes(' ') && lowered.includes(stem)),
        ...(text.match(/[\p{L}-]+/gu) ?? []).filter((word) =>
            stems.some((stem) => !stem.includes(' ') && word.toLowerCase().includes(stem)),
        ),
    ];
    return {
        purpose: [...new Set(words.map((word) => word.toLowerCase()))],
        amount: findAmount(text)?.fragment ?? null,
        term: findTerm(text)?.fragment ?? null,
    };
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
