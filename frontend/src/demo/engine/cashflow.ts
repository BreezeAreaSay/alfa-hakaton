/**
 * Прогноз денежного потока по выписке — перенос backend/app/domain/cashflow.py.
 * Формулы и округление те же, чтобы разбор выписки в браузере совпадал с сервером.
 */
import type { CashflowForecast, StatementSummary } from '../../api/types';

const HORIZON_MONTHS = 3;
const BASE_WINDOW = 3;
const GAP_BUFFER = 1.2;
const OVERDRAFT_INFLOW_SHARE = 0.4;
const STEP = 10_000;

const rubles = (value: number): number => Math.floor(value + 0.5);

/** Наклон прямой наименьших квадратов, ₽ в месяц. Меньше трёх точек — тренда нет. */
function slope(values: number[]): number {
    const n = values.length;
    if (n < 3) return 0;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let x = 0; x < n; x += 1) {
        sumX += x;
        sumY += values[x];
        sumXY += x * values[x];
        sumXX += x * x;
    }
    const denominator = n * sumXX - sumX * sumX;
    return denominator ? (n * sumXY - sumX * sumY) / denominator : 0;
}

export function nextMonth(month: string, offset: number): string {
    const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + offset;
    const year = Math.floor(index / 12);
    return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function forecast(months: StatementSummary['months'], closingBalance: number | null): CashflowForecast {
    const inflows = months.map((m) => m.inflow);
    const outflows = months.map((m) => m.outflow);
    const window = Math.min(BASE_WINDOW, months.length);
    const baseIn = inflows.slice(-window).reduce((sum, v) => sum + v, 0) / window;
    const baseOut = outflows.slice(-window).reduce((sum, v) => sum + v, 0) / window;
    const slopeIn = slope(inflows);
    const slopeOut = slope(outflows);

    let balance = closingBalance ?? 0;
    let minBalance = balance;
    let minMonth: string | null = null;
    const projected: CashflowForecast['months'] = [];
    for (let k = 1; k <= HORIZON_MONTHS; k += 1) {
        const inflow = Math.max(0, baseIn + slopeIn * k);
        const outflow = Math.max(0, baseOut + slopeOut * k);
        balance += inflow - outflow;
        const month = nextMonth(months[months.length - 1].month, k);
        projected.push({ month, inflow: rubles(inflow), outflow: rubles(outflow), balance: rubles(balance) });
        if (balance < minBalance) {
            minBalance = balance;
            minMonth = month;
        }
    }

    const gap = Math.max(0, -minBalance);
    const avgInflow = inflows.reduce((sum, v) => sum + v, 0) / inflows.length;
    const overdraftCap = Math.floor((avgInflow * OVERDRAFT_INFLOW_SHARE) / STEP) * STEP;
    let recommendation: CashflowForecast['recommendation'];
    if (gap > 0) {
        const amount = Math.ceil((gap * GAP_BUFFER) / STEP) * STEP;
        recommendation =
            amount <= overdraftCap
                ? { product: 'OVERDRAFT', amount, reason: 'GAP_COVERED_BY_OVERDRAFT' }
                : { product: 'CREDIT_LINE', amount, reason: 'GAP_ABOVE_OVERDRAFT_LIMIT' };
    } else {
        recommendation = { product: null, amount: 0, reason: 'NO_GAP' };
    }

    return {
        horizon_months: HORIZON_MONTHS,
        balance_known: closingBalance !== null,
        deficit_months: months.filter((m) => m.inflow - m.outflow < 0).map((m) => m.month),
        trend_inflow: rubles(slopeIn),
        trend_outflow: rubles(slopeOut),
        months: projected,
        min_balance: rubles(minBalance),
        min_balance_month: minMonth,
        gap: rubles(gap),
        overdraft_cap: overdraftCap,
        recommendation,
    };
}
