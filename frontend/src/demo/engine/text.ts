// Тексты для пользователей — как backend/app/domain/text.py. Числа округляются по правилам Python
// (Decimal и форматирование float), чтобы тексты совпадали с сервером символ в символ.

export function plural(n: number, one: string, few: string, many: string): string {
    const abs = Math.abs(n);
    if (abs % 10 === 1 && abs % 100 !== 11) return one;
    if (abs % 10 >= 2 && abs % 10 <= 4 && !(abs % 100 >= 12 && abs % 100 <= 14)) return few;
    return many;
}

/** «2 года 3 мес.»; genitive — после предлогов «от» и «до»: «от 1 года». */
export function monthsText(months: number, genitive = false): string {
    const years = Math.floor(months / 12);
    const rest = months % 12;
    const parts: string[] = [];
    if (years) {
        const forms: [string, string, string] = genitive ? ['года', 'лет', 'лет'] : ['год', 'года', 'лет'];
        parts.push(`${years} ${plural(years, ...forms)}`);
    }
    if (rest || !years) parts.push(`${rest} мес.`);
    return parts.join(' ');
}

export type Rounding = 'HALF_UP' | 'HALF_EVEN' | 'DOWN';

/** Десятичная запись числа без экспоненты: как Decimal(str(value)) в Python. */
function decimalDigits(value: number): { negative: boolean; int: string; frac: string } {
    let text = String(value);
    if (/e/i.test(text)) text = value.toFixed(20);
    const negative = text.startsWith('-');
    if (negative) text = text.slice(1);
    const [int, frac = ''] = text.split('.');
    return { negative, int, frac };
}

/** Округление десятичной записи числа до places знаков — как quantize у Decimal. */
export function roundDecimal(value: number, places: number, mode: Rounding): string {
    const { negative, int, frac } = decimalDigits(value);
    const kept = (int + frac.padEnd(places, '0').slice(0, places)).replace(/^0+(?=\d)/, '');
    const rest = frac.slice(places);
    let up = false;
    if (mode !== 'DOWN' && rest.length) {
        const first = rest[0];
        const tail = rest.slice(1).replace(/0+$/, '');
        if (first > '5' || (first === '5' && tail)) up = true;
        else if (first === '5') up = mode === 'HALF_UP' || Number(kept.at(-1)) % 2 === 1;
    }
    let digits = up ? (BigInt(kept) + 1n).toString() : kept;
    digits = digits.padStart(places + 1, '0');
    const whole = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
    return negative && /[1-9]/.test(digits) ? `-${whole}` : whole;
}

/**
 * Форматирование float как f"{value:.Nf}" в Python: округление точного двоичного значения,
 * точная середина — к чётному (toFixed в JS округляет середину вверх).
 */
export function pyFixed(value: number, digits: number): string {
    const fixed = value.toFixed(digits);
    const exact = Math.abs(value).toFixed(Math.min(100, digits + 20));
    const dot = exact.indexOf('.');
    const tail = exact.slice(dot + 1 + digits);
    if (!/^50*$/.test(tail)) return fixed;
    const truncated = digits ? exact.slice(0, dot + 1 + digits) : exact.slice(0, dot);
    const last = Number(truncated.replace('.', '').at(-1));
    if (last % 2 === 1) return fixed;
    return value < 0 ? `-${truncated}` : truncated;
}

/** «1 500 000 ₽»: целые рубли, разряды через обычный пробел — как rub() на сервере. */
export function rub(amount: number): string {
    const value = roundDecimal(amount, 0, 'HALF_EVEN');
    const negative = value.startsWith('-');
    const digits = negative ? value.slice(1) : value;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${negative ? '-' : ''}${grouped} ₽`;
}

/** 0,16 → «16%», с digits — «16,1%». */
export function percent(value: number, digits = 0): string {
    return `${pyFixed(value * 100, digits)}%`.replace('.', ',');
}
