// Финансовые расчёты — порт backend/app/domain/finance.py: аннуитет, обратный расчёт суммы, график.
import { addMonths } from './dates';
import { roundDecimal } from './text';

export const ROUNDING_STEP = 10_000;

/** Округление до копеек половиной вверх — money() на сервере. */
export const money = (value: number): number => Number(roundDecimal(value, 2, 'HALF_UP'));

export const monthlyRate = (annualRatePercent: number): number => annualRatePercent / 1200;

/** Сумма кредита, которую обслуживает платёж в 1 ₽ в месяц. */
export function annuityFactor(annualRatePercent: number, termMonths: number): number {
    const i = monthlyRate(annualRatePercent);
    if (i === 0) return termMonths;
    return (1 - (1 + i) ** -termMonths) / i;
}

export const annuityPayment = (amount: number, rate: number, term: number): number =>
    money(amount / annuityFactor(rate, term));

export function maxPrincipal(payment: number, rate: number, term: number): number {
    if (payment <= 0) return 0;
    return money(payment * annuityFactor(rate, term));
}

export const overpayment = (amount: number, rate: number, term: number): number =>
    money(annuityPayment(amount, rate, term) * term - amount);

export function roundDown(amount: number, step = ROUNDING_STEP): number {
    if (amount <= 0) return 0;
    return Math.floor(amount / step) * step;
}

export interface ScheduleRow {
    n: number;
    due_date: string;
    payment: number;
    principal: number;
    interest: number;
    balance: number;
}

/** Аннуитетный график. Последний платёж корректируется на остаток от округлений. */
export function paymentSchedule(amount: number, rate: number, term: number, start: string): ScheduleRow[] {
    const i = monthlyRate(rate);
    const payment = annuityPayment(amount, rate, term);
    let balance = money(amount);
    const rows: ScheduleRow[] = [];
    for (let n = 1; n <= term; n += 1) {
        const interest = money(balance * i);
        let principal = money(payment - interest);
        if (n === term) principal = balance;
        balance = money(balance - principal);
        rows.push({
            n,
            due_date: addMonths(start, n),
            payment: money(principal + interest),
            principal: money(principal),
            interest,
            balance,
        });
    }
    return rows;
}
