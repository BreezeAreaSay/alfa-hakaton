// Приоритет заявки на ручном рассмотрении и выбор аналитика при автораспределении — порт
// backend/app/domain/review.py. Правила — в docs/process.md, «Очередь аналитиков».
import type { Priority } from '../../api/types';
import { plural } from './text';

const HOUR = 3_600_000;
// Высокий приоритет: срок рассмотрения истёк или до него осталось меньше стольких часов
const URGENT_HOURS = 4;
// Средний приоритет: крупная сумма или флаги, по которым аналитику нужно что-то проверить или запросить
const LARGE_AMOUNT_MLN = 10;
const LARGE_AMOUNT = LARGE_AMOUNT_MLN * 1_000_000;
const ATTENTION_FLAGS = new Set(['F01', 'F02', 'F03', 'F04', 'F06']);
// Источник не ответил: пока он не восстановится, аналитику делать нечего
const SOURCE_FLAG = 'F05';

/** Порядок в очереди: сначала высокий приоритет, внутри приоритета — по сроку рассмотрения. */
export const PRIORITY_RANK: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, NORMAL: 2 };

export function reviewPriority(
    status: string,
    { now, sla_due_at, amount, flags }: { now: number; sla_due_at: string | null; amount: number; flags: string[] },
): { priority: Priority | null; reasons: string[] } {
    if (status !== 'MANUAL_REVIEW') return { priority: null, reasons: [] };
    if (flags.includes(SOURCE_FLAG)) return { priority: 'NORMAL', reasons: ['Ждём ответа источника'] };

    const urgent: string[] = [];
    if (sla_due_at) {
        const left = Date.parse(sla_due_at) - now;
        if (left < 0) urgent.push('Срок рассмотрения истёк');
        else if (left < URGENT_HOURS * HOUR) {
            urgent.push(`До конца срока меньше ${URGENT_HOURS} ${plural(URGENT_HOURS, 'часа', 'часов', 'часов')}`);
        }
    }

    const important: string[] = [];
    if (amount >= LARGE_AMOUNT) important.push(`Сумма от ${LARGE_AMOUNT_MLN}\u00a0млн\u00a0₽`);
    const attention = flags.filter((code) => ATTENTION_FLAGS.has(code));
    if (attention.length === 1) important.push(`Флаг ${attention[0]} требует проверки`);
    else if (attention.length) important.push(`Флаги ${attention.join(', ')} требуют проверки`);

    if (urgent.length) return { priority: 'HIGH', reasons: [...urgent, ...important] };
    if (important.length) return { priority: 'MEDIUM', reasons: important };
    return { priority: 'NORMAL', reasons: [] };
}

/**
 * Кому назначить заявку: аналитику с наименьшим числом заявок на ручном рассмотрении, при равенстве — первому
 * по логину (сравнение строк как в Python, без учёта языка). loads — логин → число заявок.
 */
export function pickAnalyst(loads: Record<string, number>): string | null {
    let best: string | null = null;
    for (const login of Object.keys(loads)) {
        if (best === null || loads[login] < loads[best] || (loads[login] === loads[best] && login < best)) {
            best = login;
        }
    }
    return best;
}
