// Балльная скоринговая карта — порт backend/app/domain/scoring.py.
import type { Features } from './features';
import { monthsText, percent, pyFixed, rub } from './text';

export const SCORING_VERSION = 'v1.0';
export const BASE_SCORE = 600;

// класс, минимальный балл, надбавка к ставке (п. п.), условная вероятность дефолта (%)
const RISK_CLASSES: [string, number, number | null, number][] = [
    ['A', 760, 0, 1],
    ['B', 680, 1.5, 3],
    ['C', 600, 3, 6],
    ['D', 520, 5, 12],
    ['E', -10_000, null, 25],
];

export interface Factor {
    code: string;
    title: string;
    value: string;
    points: number;
    phrase: string | null;
}

export interface ScoreResult {
    score: number;
    risk_class: string;
    pd: number;
    rate_margin: number | null;
    factors: Factor[];
}

const factor = (code: string, title: string, value: string, points: number, phrase: string | null = null): Factor => ({
    code,
    title,
    value,
    points,
    phrase,
});

function businessAge(f: Features): Factor {
    const title = 'Срок ведения бизнеса';
    const m = f.business_months;
    if (m === null) return factor('BUSINESS_AGE', title, 'нет данных', 0);
    const value = monthsText(m);
    if (m < 12) return factor('BUSINESS_AGE', title, value, -60, 'Бизнесу меньше года');
    if (m < 36) return factor('BUSINESS_AGE', title, value, 0);
    if (m < 60) return factor('BUSINESS_AGE', title, value, 30, 'Бизнес работает больше 3 лет');
    return factor('BUSINESS_AGE', title, value, 50, 'Бизнес работает больше 5 лет');
}

function creditHistory(f: Features): Factor {
    const title = 'Кредитная история';
    if (!f.has_credit_history) return factor('CREDIT_HISTORY', title, 'нет кредитной истории', 0);
    const days = f.max_overdue_days_24m;
    if (days === 0) {
        return factor('CREDIT_HISTORY', title, 'без просрочек за 24 мес.', 60, 'Кредиты погашаются без просрочек');
    }
    if (days < 30) {
        return factor('CREDIT_HISTORY', title, `просрочки до ${days} дн.`, -40, 'Были небольшие просрочки по кредитам');
    }
    return factor(
        'CREDIT_HISTORY',
        title,
        `просрочки до ${days} дн.`,
        -120,
        'Были просрочки по кредитам больше 30 дней',
    );
}

function debtLoad(f: Features): Factor {
    const title = 'Текущая долговая нагрузка (DSCR)';
    if (f.existing_payments === 0)
        return factor('DEBT_LOAD', title, 'нет действующих кредитов', 60, 'Нет действующих кредитов');
    if (f.dscr_current === null) return factor('DEBT_LOAD', title, 'нет данных о прибыли', 0);
    const dscr = f.dscr_current;
    const value = `${pyFixed(dscr, 2).replace('.', ',')} (платежи ${rub(f.existing_payments)} в мес.)`;
    if (dscr >= 2.0) return factor('DEBT_LOAD', title, value, 60, 'Невысокая текущая долговая нагрузка');
    if (dscr >= 1.5) return factor('DEBT_LOAD', title, value, 30, 'Умеренная долговая нагрузка');
    if (dscr >= 1.3) return factor('DEBT_LOAD', title, value, 0);
    if (dscr >= 1.0) return factor('DEBT_LOAD', title, value, -60, 'Высокая текущая долговая нагрузка');
    return factor('DEBT_LOAD', title, value, -150, 'Платежи по кредитам превышают прибыль');
}

function revenueTrend(f: Features): Factor {
    const title = 'Динамика выручки за год';
    const g = f.revenue_growth;
    if (g === null) return factor('REVENUE_TREND', title, 'нет данных за два года', 0);
    const value = (g >= 0 ? '+' : '') + percent(g);
    if (g > 0.1) return factor('REVENUE_TREND', title, value, 30, 'Выручка растёт');
    if (g >= -0.1) return factor('REVENUE_TREND', title, value, 10, 'Выручка стабильна');
    if (g >= -0.3) return factor('REVENUE_TREND', title, value, -40, 'Выручка снизилась');
    return factor('REVENUE_TREND', title, value, -100, 'Выручка сильно снизилась');
}

function margin(f: Features): Factor {
    const title = 'Рентабельность продаж';
    const m = f.margin;
    if (m === null) return factor('MARGIN', title, 'нет данных', 0);
    const value = percent(m, 1);
    if (m > 0.15) return factor('MARGIN', title, value, 30, 'Высокая рентабельность бизнеса');
    if (m >= 0.05) return factor('MARGIN', title, value, 10, 'Бизнес прибыльный');
    if (m >= 0) return factor('MARGIN', title, value, -10, 'Низкая рентабельность');
    return factor('MARGIN', title, value, -80, 'Бизнес работает в убыток');
}

function account(f: Features): Factor {
    const title = 'Поступления на счёт в банке';
    if (!f.is_bank_client) return factor('ACCOUNT', title, 'не клиент банка', 0);
    const months = f.inflow_months;
    let value = `${months} из 12 мес.`;
    if (f.avg_monthly_inflow !== null) value += `, в среднем ${rub(f.avg_monthly_inflow)}`;
    if (months >= 6 && f.inflow_cv !== null && f.inflow_cv > 0.5) {
        return factor('ACCOUNT', title, value, -20, 'Нерегулярные поступления на счёт');
    }
    if (months >= 12) return factor('ACCOUNT', title, value, 40, 'Стабильные поступления на счёт в банке');
    if (months >= 6) return factor('ACCOUNT', title, value, 20, 'Регулярные поступления на счёт в банке');
    return factor('ACCOUNT', title, value, 0);
}

function taxDebt(f: Features): Factor {
    const title = 'Налоговая задолженность';
    const debt = f.tax_debt;
    if (debt <= 0) return factor('TAX_DEBT', title, 'нет', 0);
    if (debt <= 100_000) return factor('TAX_DEBT', title, rub(debt), -30, 'Есть налоговая задолженность');
    return factor('TAX_DEBT', title, rub(debt), -100, 'Значительная налоговая задолженность');
}

const INDUSTRY_LABELS = { LOW: 'низкий', MEDIUM: 'средний', HIGH: 'высокий' } as const;

function industry(f: Features): Factor {
    const title = 'Отраслевой риск';
    const value = INDUSTRY_LABELS[f.industry_risk] + (f.okved ? ` (ОКВЭД ${f.okved})` : '');
    if (f.industry_risk === 'LOW') return factor('INDUSTRY', title, value, 10, 'Отрасль с низким риском');
    if (f.industry_risk === 'HIGH') return factor('INDUSTRY', title, value, -40, 'Отрасль с повышенным риском');
    return factor('INDUSTRY', title, value, 0);
}

function amountShare(f: Features): Factor {
    const title = 'Доля суммы в годовой выручке';
    const share = f.amount_share;
    if (share === null) return factor('AMOUNT_SHARE', title, 'нет данных о выручке', 0);
    const value = percent(share);
    if (share <= 0.25) return factor('AMOUNT_SHARE', title, value, 20, 'Сумма небольшая относительно выручки');
    if (share <= 0.5) return factor('AMOUNT_SHARE', title, value, 0);
    return factor('AMOUNT_SHARE', title, value, -60, 'Сумма большая относительно выручки');
}

const FACTORS = [businessAge, creditHistory, debtLoad, revenueTrend, margin, account, taxDebt, industry, amountShare];

export function riskClassFor(points: number): [string, number | null, number] {
    for (const [name, minimum, rateMargin, pd] of RISK_CLASSES) {
        if (points >= minimum) return [name, rateMargin, pd];
    }
    throw new Error('unreachable');
}

export function score(features: Features): ScoreResult {
    const factors = FACTORS.map((fn) => fn(features));
    const total = BASE_SCORE + factors.reduce((sum, f) => sum + f.points, 0);
    const [riskClass, rateMargin, pd] = riskClassFor(total);
    return { score: total, risk_class: riskClass, pd, rate_margin: rateMargin, factors };
}
