// Признаки для скоринга и политики из ответов источников — порт backend/app/domain/features.py.
import { monthsBetween } from './dates';
import { money } from './finance';

/** Ответ внешнего источника — произвольный JSON. */
export type Json = Record<string, any>;

const LOW_RISK_OKVED = new Set(['62', '63', '69', '70', '86']);
const HIGH_RISK_OKVED = new Set(['41', '42', '43', '55', '56', '68']);

export function industryRisk(okved: string | null): 'LOW' | 'MEDIUM' | 'HIGH' {
    const prefix = (okved ?? '').slice(0, 2);
    if (LOW_RISK_OKVED.has(prefix)) return 'LOW';
    if (HIGH_RISK_OKVED.has(prefix)) return 'HIGH';
    return 'MEDIUM';
}

/** Отраслевая маржа для оценки прибыли, когда нет отчётности. */
export function industryMargin(okved: string | null): number {
    const prefix = (okved || '0').slice(0, 2);
    const value = /^\s*[+-]?\d+\s*$/.test(prefix) ? Number.parseInt(prefix, 10) : 0;
    if ([45, 46, 47].includes(value)) return 0.08;
    if (value >= 10 && value <= 33) return 0.12;
    if (value >= 49 && value <= 53) return 0.12;
    if ([41, 42, 43].includes(value)) return 0.1;
    if ([55, 56].includes(value)) return 0.15;
    return 0.2;
}

export interface Features {
    legal_form: string | null;
    company_status: string | null;
    business_months: number | null;
    okved: string | null;
    industry_risk: 'LOW' | 'MEDIUM' | 'HIGH';
    industry_margin: number;

    revenue: number | null;
    revenue_source: string | null;
    revenue_prev: number | null;
    sales_profit: number | null;
    operating_profit_month: number | null;
    revenue_growth: number | null;
    margin: number | null;

    has_credit_history: boolean;
    existing_payments: number;
    existing_debt: number;
    dscr_current: number | null;
    max_overdue_days_24m: number;
    current_overdue_days: number;

    is_bank_client: boolean;
    account_months: number;
    inflow_months: number;
    inflow_cv: number | null;
    avg_monthly_inflow: number | null;

    tax_debt: number;
    mass_address: boolean;
    director_disqualified: boolean;
    director_months: number | null;

    amount: number;
    term_months: number;
    declared_revenue: number | null;
    revenue_discrepancy: number | null;
    amount_share: number | null;

    unavailable_sources: string[];
}

const dateOf = (value: unknown): string | null =>
    value === null || value === undefined || value === '' ? null : String(value).slice(0, 10);
const numberOf = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** Стандартное отклонение по генеральной совокупности (statistics.pstdev). */
function pstdev(values: number[]): number {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const squares = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
    return Math.sqrt(squares / values.length);
}

/** Число месяцев с поступлениями, коэффициент вариации, среднемесячные поступления и выручка за год. */
function inflowStats(months: Json[]): [number, number | null, number | null, number | null] {
    const values = months.slice(-12).map((m) => Number(m.inflow || 0));
    if (!values.length) return [0, null, null, null];
    const withInflow = values.filter((v) => v > 0).length;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const cv = mean > 0 && values.length > 1 ? pstdev(values) / mean : null;
    return [withInflow, cv, money(mean), money(mean * 12)];
}

export interface FeatureInputs {
    today: string;
    amount: number;
    term_months: number;
    declared_revenue: number | null;
    egrul: Json | null;
    fns: Json | null;
    girbo: Json | null;
    bki: Json | null;
    bank: Json | null;
    statement: Json | null;
    unavailable_sources?: string[];
}

export function buildFeatures(input: FeatureInputs): Features {
    const { today, amount, term_months, declared_revenue, egrul, fns, girbo, bki, bank, statement } = input;
    const f: Features = {
        legal_form: null,
        company_status: null,
        business_months: null,
        okved: null,
        industry_risk: 'MEDIUM',
        industry_margin: 0.2,
        revenue: null,
        revenue_source: null,
        revenue_prev: null,
        sales_profit: null,
        operating_profit_month: null,
        revenue_growth: null,
        margin: null,
        has_credit_history: false,
        existing_payments: 0,
        existing_debt: 0,
        dscr_current: null,
        max_overdue_days_24m: 0,
        current_overdue_days: 0,
        is_bank_client: false,
        account_months: 0,
        inflow_months: 0,
        inflow_cv: null,
        avg_monthly_inflow: null,
        tax_debt: 0,
        mass_address: false,
        director_disqualified: false,
        director_months: null,
        amount,
        term_months,
        declared_revenue,
        revenue_discrepancy: null,
        amount_share: null,
        unavailable_sources: [...(input.unavailable_sources ?? [])],
    };

    if (egrul && egrul.found) {
        f.legal_form = egrul.legal_form ?? null;
        f.company_status = egrul.status ?? null;
        f.okved = egrul.okved ?? null;
        const registered = dateOf(egrul.registration_date);
        if (registered) f.business_months = monthsBetween(registered, today);
        const directorSince = dateOf((egrul.director ?? {}).since);
        if (directorSince) f.director_months = monthsBetween(directorSince, today);
    }
    f.industry_risk = industryRisk(f.okved);
    f.industry_margin = industryMargin(f.okved);

    if (fns) {
        f.tax_debt = numberOf(fns.tax_debt) || 0;
        f.mass_address = Boolean(fns.mass_address);
        f.director_disqualified = Boolean(fns.director_disqualified);
    }

    if (bki) {
        f.has_credit_history = Boolean(bki.has_history);
        const loans: Json[] = bki.loans ?? [];
        f.existing_payments = money(loans.reduce((sum, loan) => sum + Number(loan.monthly_payment || 0), 0));
        f.existing_debt = money(loans.reduce((sum, loan) => sum + Number(loan.balance || 0), 0));
        f.max_overdue_days_24m = Math.trunc(Number(bki.max_overdue_days_24m || 0));
        f.current_overdue_days = Math.trunc(Number(bki.current_overdue_days || 0));
    }

    let bankAnnual: number | null = null;
    if (bank && bank.is_client) {
        f.is_bank_client = true;
        const opened = dateOf(bank.account_opened_at);
        if (opened) f.account_months = monthsBetween(opened, today);
        [f.inflow_months, f.inflow_cv, f.avg_monthly_inflow, bankAnnual] = inflowStats(bank.months ?? []);
    }

    let statementAnnual: number | null = null;
    let statementAvg: number | null = null;
    if (statement && statement.months?.length) {
        [, , statementAvg, statementAnnual] = inflowStats(statement.months);
    }

    // Источник выручки по приоритету: отчётность → поступления на счёт в банке → выписка клиента.
    const years: Json[] = [...((girbo ?? {}).years ?? [])].sort((a, b) => b.year - a.year);
    if (girbo && girbo.available && years.length) {
        f.revenue = numberOf(years[0].revenue);
        f.sales_profit = numberOf(years[0].sales_profit);
        f.revenue_source = 'GIRBO';
        if (years.length > 1) f.revenue_prev = numberOf(years[1].revenue);
    } else if (bankAnnual !== null && f.account_months >= 3) {
        f.revenue = bankAnnual;
        f.revenue_source = 'BANK';
    } else if (statementAnnual !== null) {
        f.revenue = statementAnnual;
        f.revenue_source = 'STATEMENT';
        if (f.avg_monthly_inflow === null) f.avg_monthly_inflow = statementAvg;
    }

    if (f.revenue !== null && f.revenue > 0) {
        if (f.sales_profit !== null) {
            f.operating_profit_month = money(f.sales_profit / 12);
            f.margin = f.sales_profit / f.revenue;
        } else {
            f.operating_profit_month = money((f.revenue * f.industry_margin) / 12);
        }
        if (f.revenue_prev) f.revenue_growth = (f.revenue - f.revenue_prev) / f.revenue_prev;
        f.amount_share = amount / f.revenue;
        if (declared_revenue) f.revenue_discrepancy = Math.abs(declared_revenue - f.revenue) / f.revenue;
    }

    if (f.operating_profit_month !== null && f.existing_payments > 0) {
        f.dscr_current = f.operating_profit_month / f.existing_payments;
    }
    return f;
}
