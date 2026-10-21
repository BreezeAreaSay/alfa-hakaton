// Даты без времени ('YYYY-MM-DD') по UTC — как date на сервере и в симуляторе внешних систем.

export interface Ymd {
    y: number;
    m: number;
    d: number;
}

export function parseDate(value: string): Ymd {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return { y, m, d: d || 1 };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export const formatDate = ({ y, m, d }: Ymd): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

export const todayUtc = (now: number = Date.now()): string => new Date(now).toISOString().slice(0, 10);

export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Полных месяцев между датами — months_between на сервере. */
export function monthsBetween(start: string, end: string): number {
    const a = parseDate(start);
    const b = parseDate(end);
    let months = (b.y - a.y) * 12 + (b.m - a.m);
    if (b.d < a.d) months -= 1;
    return Math.max(months, 0);
}

/** Та же дата через n месяцев; день — не больше последнего дня месяца (add_months). */
export function addMonths(start: string, n: number): string {
    const s = parseDate(start);
    const index = s.y * 12 + (s.m - 1) + n;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    return formatDate({ y, m, d: Math.min(s.d, daysInMonth(y, m)) });
}

export const monthIndex = (value: string): number => {
    const { y, m } = parseDate(value.length === 7 ? `${value}-01` : value);
    return y * 12 + m - 1;
};

/** Дата k месяцев назад, день не позже 28-го — как months_ago в симуляторе. */
export function monthsAgo(k: number, today: string): string {
    const t = parseDate(today);
    const index = t.y * 12 + t.m - 1 - k;
    return formatDate({ y: Math.floor(index / 12), m: (index % 12) + 1, d: Math.min(t.d, 28) });
}
