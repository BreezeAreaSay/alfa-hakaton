/**
 * Предварительные предложения на главной — перенос backend/app/domain/proactive.py.
 * Те же правила политики, что и лимит в заявке, но без кредитной истории и без заявки.
 */
import { PRODUCTS } from './catalog';
import { type Features, type FeatureInputs, buildFeatures } from './features';
import { roundDown } from './finance';
import { computeLimit, eligibilityIssues, offerFigures } from './policy';
import { monthsText, rub } from './text';

export const CANDIDATES = ['OVERDRAFT', 'GROWTH', 'CREDIT_LINE', 'EXPRESS'];
export const TYPICAL_TERM = 36;
const PURPOSES: Record<string, string> = {
    OVERDRAFT: 'CASH_GAP',
    CREDIT_LINE: 'WORKING_CAPITAL',
    GROWTH: 'WORKING_CAPITAL',
    EXPRESS: 'WORKING_CAPITAL',
};

export const NOTE_PRELIMINARY =
    'Предварительно, без учёта кредитной истории. Точные условия — после проверки по заявке.';
export const NOTE_NO_DATA =
    'Чтобы рассчитать предложение заранее, нужна отчётность или поступления на счёт за три месяца и больше. ' +
    'Подайте заявку — приложите выписку из другого банка, и мы оценим выручку по ней.';

export const NOTE_STATEMENT =
    'Предварительно, по выписке и данным ЕГРЮЛ/ЕГРИП, без кредитной истории. ' +
    'Точные условия — после проверки по заявке; эту выписку можно приложить к ней.';
export const NOTE_STATEMENT_NONE =
    'По этой выписке предложить продукт заранее не получилось: поступлений слишком мало или компания не ' +
    'действует. Подайте заявку — её рассмотрит специалист.';

export interface ProactiveOfferRow {
    product_code: string;
    product_name: string;
    kind: string;
    purpose: string;
    amount: number;
    term_months: number;
    rate_from: number;
    monthly_payment: number;
}

/** Овердрафт (если доступен) и один кредитный продукт с наибольшей суммой в пределах автолимита. */
export function proactiveOffers(f: Features): ProactiveOfferRow[] {
    if (f.company_status !== 'ACTIVE' || f.revenue === null) return [];
    const found: ProactiveOfferRow[] = [];
    for (const code of CANDIDATES) {
        const product = PRODUCTS.find((p) => p.code === code);
        if (!product) continue;
        const issues = eligibilityIssues(product, {
            business_months: f.business_months,
            is_bank_client: f.is_bank_client,
            account_months: f.account_months,
        });
        if (issues.length) continue;
        const term = Math.min(Math.max(TYPICAL_TERM, product.min_term), product.max_term);
        const limit = computeLimit(product, f, {
            rate: product.base_rate,
            term_months: term,
            collateral_value: null,
        }).limit;
        if (limit === null) continue;
        const cap = product.auto_limit !== null ? product.auto_limit : product.max_amount;
        const amount = roundDown(Math.min(limit, cap));
        if (amount < product.min_amount) continue;
        const [monthly] = offerFigures(product, amount, product.base_rate, term);
        found.push({
            product_code: code,
            product_name: product.name,
            kind: product.kind,
            purpose: PURPOSES[code],
            amount,
            term_months: term,
            rate_from: product.base_rate,
            monthly_payment: monthly,
        });
    }
    const overdraft = found.filter((o) => o.product_code === 'OVERDRAFT');
    const loans = found.filter((o) => o.product_code !== 'OVERDRAFT').sort((a, b) => b.amount - a.amount);
    return [...overdraft.slice(0, 1), ...loans.slice(0, 1)];
}

/** На чём основано предложение — простыми словами, по тем же признакам, что и в досье. */
export function proactiveFacts(f: Features): string[] {
    const facts: string[] = [];
    if (f.business_months !== null) facts.push(`Бизнес работает ${monthsText(f.business_months)}`);
    if (f.revenue !== null && f.revenue_source === 'GIRBO') {
        facts.push(`Выручка по отчётности — ${rub(f.revenue)} в год`);
        if (f.revenue_growth !== null && Math.abs(f.revenue_growth) >= 0.05) {
            const change = f.revenue_growth > 0 ? 'выросла' : 'снизилась';
            facts.push(`Выручка ${change} на ${Math.round(Math.abs(f.revenue_growth) * 100)} % за год`);
        }
    }
    if (f.is_bank_client && f.avg_monthly_inflow !== null && f.inflow_months >= 3) {
        facts.push(`Поступления на счёт — в среднем ${rub(f.avg_monthly_inflow)} в месяц`);
    }
    return facts;
}

export function proactiveNote(f: Features, offers: ProactiveOfferRow[]): string | null {
    if (offers.length) return NOTE_PRELIMINARY;
    if (f.company_status === 'ACTIVE' && f.revenue === null) return NOTE_NO_DATA;
    return null;
}

type Json = FeatureInputs['statement'];

/**
 * Признаки «по выписке»: поступления и выручка — из выписки клиента, допуск к продуктам — по счёту в банке.
 * Выписка подставляется вместо оборотов по счёту; отчётность и кредитная история не участвуют.
 */
export function statementFeatures({
    today,
    egrul,
    bank,
    statement,
}: {
    today: string;
    egrul: Json;
    bank: Json;
    statement: NonNullable<Json>;
}): Features {
    const bankView =
        bank && bank.is_client
            ? { is_client: true, account_opened_at: bank.account_opened_at, months: statement.months ?? [] }
            : null;
    return buildFeatures({
        today,
        amount: 0,
        term_months: TYPICAL_TERM,
        declared_revenue: null,
        egrul,
        fns: null,
        girbo: null,
        bki: null,
        bank: bankView,
        statement,
    });
}

/** На чём основан расчёт по выписке. */
export function statementFacts(f: Features, statement: NonNullable<Json>): string[] {
    const months = (statement.months ?? []) as unknown[];
    const facts = [
        `По выписке: ${months.length} мес., в среднем ${rub(Number(statement.avg_monthly_inflow ?? 0))} поступлений в месяц`,
    ];
    if (f.business_months !== null) facts.push(`Бизнес работает ${monthsText(f.business_months)}`);
    if (f.is_bank_client && f.account_months > 0) facts.push(`Счёт в банке: ${monthsText(f.account_months)}`);
    return facts;
}
