// Кредитная политика: допуск, лимит, решение, контрпредложения — порт backend/app/domain/policy.py.
// Тексты флагов, стоп-факторов и причин берутся из справочника /api/meta (fixtures/meta.json).
import meta from '../fixtures/meta.json';
import { PRODUCTS, type ProductTerms, productPurposes } from './catalog';
import type { Features } from './features';
import { annuityPayment, maxPrincipal, money, overpayment, roundDown } from './finance';
import type { Factor, ScoreResult } from './scoring';
import { monthsText, rub } from './text';

export const POLICY_VERSION = 'v1.0';

const DSCR_MIN = 1.3;
const UNSECURED_REVENUE_SHARE = 0.5;
const SECURED_REVENUE_SHARE = 1.0;
const COLLATERAL_LTV = 0.8;
const OVERDRAFT_INFLOW_SHARE = 0.4;
const MIN_BUSINESS_MONTHS = 3;
const DIRECTOR_CHANGE_MONTHS = 6;
const REVENUE_DISCREPANCY = 0.3;
const ANALYST_LIMIT_TOLERANCE = 1.2;

const BAD_COMPANY_STATUSES = new Set(['LIQUIDATING', 'REORGANIZING', 'BANKRUPTCY', 'LIQUIDATED']);
export const REVOLVING_KINDS = new Set(['OVERDRAFT', 'CREDIT_LINE']);

export const FLAGS: Record<string, string> = meta.flags;
export const STOP_FACTORS: Record<string, string> = meta.stop_factors;
export const LIMIT_PHRASES: Record<string, string> = meta.limit_phrases;
export const REASONS: Record<string, { bank: string; client: string }> = meta.reasons;
export const ADVICE: Record<string, string> = meta.advice;
export const CHEAPER_WHY: Record<string, string> = meta.cheaper_why;
export const FACTOR_ADVICE: Record<string, string> = meta.factor_advice;
export const KEY_RATE: number = meta.key_rate;

// Совет по оценке риска (S05, R01) — из факторов скоринга заявки, как RISK_ADVICE в policy.py; общий текст из ADVICE
// остаётся, только если отрицательных факторов нет. При стоп-факторах S01–S04 этого совета нет.
const RISK_ADVICE_CODES = new Set(['S05', 'R01']);
const riskAdvice = (causes: string[]): string =>
    `Оценка станет выше, когда ${causes.join(' и ')}. Начать можно с небольшой суммы через несколько месяцев`;
const BLOCKING_STOP_FACTORS = new Set(['S01', 'S02', 'S03', 'S04']);

export const STATEMENT_REQUEST_ITEM = {
    code: 'BANK_STATEMENT',
    title: 'Выписка по расчётному счёту за последние 12 месяцев',
    hint: 'Файл выгрузки из банка в формате 1С (.txt) или таблица CSV. По ней мы оценим выручку.',
};

export interface Issue {
    code: string;
    text: string;
}

export interface OfferOption {
    kind: 'AS_REQUESTED' | 'COUNTER';
    product_code: string;
    amount: number;
    term_months: number;
    rate: number;
    monthly_payment: number;
    overpayment: number;
    note: string | null;
}

export interface Constraint {
    code: string;
    amount: number;
    max_payment?: number;
}

export interface LimitResult {
    limit: number | null;
    binding: string | null;
    constraints: Constraint[];
}

export interface TraceRow {
    rule: string;
    result: string;
    detail: string;
}

export interface PolicyDecision {
    outcome: 'APPROVE' | 'COUNTER' | 'REJECT' | 'NEED_INFO' | 'MANUAL_REVIEW';
    policy_version: string;
    rate: number | null;
    limit: number | null;
    limit_binding: string | null;
    stop_factors: string[];
    flags: string[];
    reason_codes: string[];
    options: OfferOption[];
    info_items: { code: string; title: string; hint?: string }[];
    trace: TraceRow[];
}

export function newDecision(outcome: PolicyDecision['outcome'], extra: Partial<PolicyDecision> = {}): PolicyDecision {
    return {
        outcome,
        policy_version: POLICY_VERSION,
        rate: null,
        limit: null,
        limit_binding: null,
        stop_factors: [],
        flags: [],
        reason_codes: [],
        options: [],
        info_items: [],
        trace: [],
        ...extra,
    };
}

export const note = (d: PolicyDecision, rule: string, result: string, detail = ''): void => {
    d.trace.push({ rule, result, detail });
};

export function eligibilityIssues(
    product: ProductTerms,
    {
        business_months,
        is_bank_client,
        account_months,
        amount,
        term_months,
    }: {
        business_months: number | null;
        is_bank_client: boolean;
        account_months: number;
        amount?: number | null;
        term_months?: number | null;
    },
): Issue[] {
    const issues: Issue[] = [];
    if (business_months !== null) {
        if (business_months < product.min_business_months) {
            const age = monthsText(product.min_business_months, true);
            issues.push({ code: 'BUSINESS_AGE', text: `Доступен бизнесу от ${age}` });
        }
        if (product.max_business_months !== null && business_months >= product.max_business_months) {
            issues.push({ code: 'BUSINESS_AGE', text: 'Только для бизнеса младше года' });
        }
    }
    const required = product.requires_bank_account_months;
    if (required !== null && (!is_bank_client || account_months < required)) {
        issues.push({
            code: 'BANK_ACCOUNT',
            text: `Доступен клиентам банка с поступлениями на счёт от ${required} мес.`,
        });
    }
    if (amount !== undefined && amount !== null && !(product.min_amount <= amount && amount <= product.max_amount)) {
        issues.push({ code: 'AMOUNT', text: `Сумма от ${rub(product.min_amount)} до ${rub(product.max_amount)}` });
    }
    if (
        term_months !== undefined &&
        term_months !== null &&
        !(product.min_term <= term_months && term_months <= product.max_term)
    ) {
        if (product.min_term === product.max_term) issues.push({ code: 'TERM', text: `Срок ${product.min_term} мес.` });
        else issues.push({ code: 'TERM', text: `Срок от ${product.min_term} до ${product.max_term} мес.` });
    }
    return issues;
}

/** Платёж и переплата. Для овердрафта и линии — проценты при полном использовании лимита. */
export function offerFigures(product: ProductTerms, amount: number, rate: number, term: number): [number, number] {
    if (REVOLVING_KINDS.has(product.kind)) {
        const monthly = money((amount * rate) / 1200);
        return [monthly, money(monthly * term)];
    }
    return [annuityPayment(amount, rate, term), overpayment(amount, rate, term)];
}

export const paymentLabel = (kind: string): string =>
    REVOLVING_KINDS.has(kind) ? 'Проценты в месяц при полном использовании лимита' : 'Ежемесячный платёж';

export function computeLimit(
    product: ProductTerms,
    f: Features,
    { rate, term_months, collateral_value }: { rate: number; term_months: number; collateral_value: number | null },
): LimitResult {
    const constraints: Constraint[] = [{ code: 'PRODUCT_MAX', amount: product.max_amount }];
    if (product.kind === 'OVERDRAFT') {
        if (f.avg_monthly_inflow === null) return { limit: null, binding: null, constraints };
        constraints.push({ code: 'OVERDRAFT', amount: money(f.avg_monthly_inflow * OVERDRAFT_INFLOW_SHARE) });
    } else {
        if (f.revenue === null || f.operating_profit_month === null) return { limit: null, binding: null, constraints };
        if (product.collateral_required) {
            constraints.push({ code: 'REVENUE', amount: money(f.revenue * SECURED_REVENUE_SHARE) });
            constraints.push({ code: 'COLLATERAL', amount: money((collateral_value || 0) * COLLATERAL_LTV) });
        } else {
            constraints.push({ code: 'REVENUE', amount: money(f.revenue * UNSECURED_REVENUE_SHARE) });
        }
        const maxPayment = f.operating_profit_month / DSCR_MIN - f.existing_payments;
        let dscrAmount: number;
        if (REVOLVING_KINDS.has(product.kind)) {
            // Для линии: проценты и равное погашение основного долга за срок.
            dscrAmount = maxPayment > 0 ? maxPayment / (rate / 1200 + 1 / term_months) : 0;
        } else {
            dscrAmount = maxPrincipal(maxPayment, rate, term_months);
        }
        constraints.push({ code: 'DSCR', amount: money(dscrAmount), max_payment: money(maxPayment) });
    }
    let binding = constraints[0];
    for (const c of constraints) if (c.amount < binding.amount) binding = c;
    return { limit: roundDown(binding.amount), binding: binding.code, constraints };
}

export function stopFactors(f: Features, s: ScoreResult): string[] {
    const found: string[] = [];
    if (f.company_status !== null && BAD_COMPANY_STATUSES.has(f.company_status)) found.push('S01');
    if (f.director_disqualified) found.push('S02');
    if (f.current_overdue_days > 30) found.push('S03');
    if (f.business_months !== null && f.business_months < MIN_BUSINESS_MONTHS) found.push('S04');
    if (s.risk_class === 'E') found.push('S05');
    return found;
}

export function reviewFlags(f: Features, s: ScoreResult): string[] {
    const found: string[] = [];
    if (f.mass_address) found.push('F01');
    if (f.tax_debt > 0) found.push('F02');
    if (f.director_months !== null && f.director_months < DIRECTOR_CHANGE_MONTHS) found.push('F03');
    if (f.revenue_discrepancy !== null && f.revenue_discrepancy > REVENUE_DISCREPANCY) found.push('F04');
    if (f.unavailable_sources.length) found.push('F05');
    if (f.current_overdue_days > 0 && f.current_overdue_days <= 30) found.push('F06');
    if (s.risk_class === 'C' || s.risk_class === 'D') found.push('F07');
    return found;
}

export const rateFor = (product: ProductTerms, s: ScoreResult): number | null =>
    s.rate_margin === null ? null : product.base_rate + s.rate_margin;

function option(
    product: ProductTerms,
    kind: OfferOption['kind'],
    amount: number,
    term: number,
    rate: number,
    optionNote: string | null = null,
): OfferOption {
    const [monthly, over] = offerFigures(product, amount, rate, term);
    return {
        kind,
        product_code: product.code,
        amount: money(amount),
        term_months: term,
        rate,
        monthly_payment: monthly,
        overpayment: over,
        note: optionNote,
    };
}

/** Та же сумма на более длинный срок, если на каком-то сроке она вписывается в лимит. */
function longerTermOption(
    product: ProductTerms,
    f: Features,
    {
        amount,
        term,
        rate,
        collateral_value,
    }: { amount: number; term: number; rate: number; collateral_value: number | null },
): OfferOption | null {
    if (REVOLVING_KINDS.has(product.kind)) return null;
    // Сроки, кратные полугоду, — их проще воспринимать, чем «57 месяцев».
    const candidates = new Set<number>();
    for (let t = 6; t <= product.max_term; t += 6) if (t > term) candidates.add(t);
    candidates.add(product.max_term);
    candidates.delete(term);
    for (const longer of [...candidates].sort((a, b) => a - b).filter((t) => t > term)) {
        const result = computeLimit(product, f, { rate, term_months: longer, collateral_value });
        if (result.limit !== null && result.limit >= amount) {
            return option(
                product,
                'COUNTER',
                amount,
                longer,
                rate,
                `Та же сумма на ${monthsText(longer)} — платёж ниже`,
            );
        }
    }
    return null;
}

export function decide(
    product: ProductTerms,
    f: Features,
    s: ScoreResult,
    { amount, term_months, collateral_value }: { amount: number; term_months: number; collateral_value: number | null },
): PolicyDecision {
    const d = newDecision('MANUAL_REVIEW');

    d.stop_factors = stopFactors(f, s);
    if (d.stop_factors.length) {
        d.outcome = 'REJECT';
        note(d, 'Стоп-факторы', 'отказ', d.stop_factors.join(', '));
        return d;
    }
    note(d, 'Стоп-факторы', 'нет');

    const issues = eligibilityIssues(product, {
        business_months: f.business_months,
        is_bank_client: f.is_bank_client,
        account_months: f.account_months,
        amount,
        term_months,
    });
    if (product.collateral_required && !collateral_value)
        issues.push({ code: 'COLLATERAL', text: 'Для продукта нужен залог' });
    if (issues.length) {
        d.outcome = 'REJECT';
        d.reason_codes = ['R06'];
        note(d, 'Условия продукта', 'не выполнены', issues.map((i) => i.text).join('; '));
        return d;
    }
    note(d, 'Условия продукта', 'выполнены');

    const rate = rateFor(product, s) as number;
    d.rate = rate;
    const limit = computeLimit(product, f, { rate, term_months, collateral_value });
    if (limit.limit === null) {
        d.outcome = 'NEED_INFO';
        d.info_items = [STATEMENT_REQUEST_ITEM];
        note(d, 'Финансовые данные', 'нет источника', 'нужна выписка по счёту');
        return d;
    }
    d.limit = limit.limit;
    d.limit_binding = limit.binding;
    note(d, 'Лимит', rub(limit.limit), LIMIT_PHRASES[limit.binding ?? ''] ?? '');

    if (limit.limit < product.min_amount) {
        d.outcome = 'REJECT';
        d.reason_codes = ['R02'];
        note(d, 'Лимит не меньше минимальной суммы', 'нет', `минимум ${rub(product.min_amount)}`);
        return d;
    }

    d.flags = reviewFlags(f, s);
    if (d.flags.length || product.always_manual) {
        d.outcome = 'MANUAL_REVIEW';
        const detail = d.flags.length ? d.flags.join(', ') : 'продукт рассматривает аналитик';
        note(d, 'Флаги ручного рассмотрения', 'есть', detail);
        return d;
    }
    note(d, 'Флаги ручного рассмотрения', 'нет');

    const offered = Math.min(amount, limit.limit);
    const autoLimit = product.auto_limit ?? 0;
    if (offered > autoLimit) {
        d.outcome = 'MANUAL_REVIEW';
        note(d, 'Автолимит', 'превышен', `${rub(offered)} > ${rub(autoLimit)}`);
        return d;
    }
    note(d, 'Автолимит', 'в пределах', rub(autoLimit));

    if (offered >= amount) {
        d.outcome = 'APPROVE';
        d.options = [option(product, 'AS_REQUESTED', amount, term_months, rate)];
        note(d, 'Решение', 'одобрено как запрошено');
        return d;
    }

    d.outcome = 'COUNTER';
    if (amount <= autoLimit) {
        const longer = longerTermOption(product, f, { amount, term: term_months, rate, collateral_value });
        if (longer) d.options.push(longer);
    }
    d.options.push(
        option(product, 'COUNTER', offered, term_months, rate, `Меньшая сумма на ${monthsText(term_months)}`),
    );
    d.options.forEach((item, index) => {
        item.note = item.note || `Вариант ${index + 1}`;
    });
    note(d, 'Решение', 'контрпредложение', `вариантов: ${d.options.length}`);
    return d;
}

/** Проценты и процентные пункты по-русски: 1,5 / 0 / 5 — как `pp` в policy.py. */
export const pp = (value: number): string => String(value).replace('.', ',');

export interface RateBreakdown {
    key_rate: number;
    product_spread: number;
    risk_margin: number;
    adjustment: number;
    rate: number;
}

export interface RateHint {
    kind: 'product' | 'risk';
    text: string;
    product_code: string | null;
    product_name: string | null;
    rate: number | null;
    saving: number | null;
}

export interface Alternative {
    product_code: string;
    product_name: string;
    max_amount: number;
    term_months: number;
    rate: number;
}

/** Из чего складывается ставка: ключевая + спред продукта + надбавка за риск (+ решение аналитика). */
export function rateBreakdown(product: ProductTerms, riskMargin: number, offerRate: number | null): RateBreakdown {
    const spread = money(product.base_rate - KEY_RATE);
    const policyRate = money(product.base_rate + riskMargin);
    const adjustment = offerRate === null ? 0 : money(offerRate - policyRate);
    return {
        key_rate: KEY_RATE,
        product_spread: spread,
        risk_margin: riskMargin,
        adjustment,
        rate: money(policyRate + adjustment),
    };
}

const byBaseRate = (): ProductTerms[] => [...PRODUCTS].sort((a, b) => a.base_rate - b.base_rate);

const fitsPurpose = (code: string, purpose: string | null): boolean => {
    const purposes = productPurposes(code);
    return !purpose || !purposes.length || purposes.includes(purpose);
};

/**
 * Что улучшит оценку: продолжения фраз из FACTOR_ADVICE для факторов скоринга с наибольшим отрицательным вкладом
 * (factor_causes в policy.py). Отраслевой риск совета не получает — отрасль клиент не меняет.
 */
export function factorCauses(factors: Pick<Factor, 'code' | 'points'>[], limit = 2): string[] {
    return factors
        .filter((x) => x.points < 0)
        .sort((a, b) => a.points - b.points)
        .filter((x) => x.code in FACTOR_ADVICE)
        .map((x) => FACTOR_ADVICE[x.code])
        .slice(0, limit);
}

/** Как получить ставку ниже: более дешёвые продукты под ту же цель, доступные компании, и что снизит надбавку. */
export function rateHints(
    product: ProductTerms,
    f: Features,
    {
        riskMargin,
        factors,
        purpose,
        rate,
    }: { riskMargin: number; factors: Factor[]; purpose: string | null; rate: number },
): RateHint[] {
    const hints: RateHint[] = [];
    for (const other of byBaseRate()) {
        if (other.code === product.code) continue;
        const otherRate = money(other.base_rate + riskMargin);
        if (otherRate >= rate) continue;
        if (!fitsPurpose(other.code, purpose)) continue;
        const issues = eligibilityIssues(other, {
            business_months: f.business_months,
            is_bank_client: f.is_bank_client,
            account_months: f.account_months,
            amount: f.amount || null,
        });
        if (issues.length) continue;
        const why = CHEAPER_WHY[other.code] ?? 'ставка ниже за счёт условий продукта';
        let text = `${other.name} — ${pp(otherRate)}\u00a0%: ${why}`;
        let saving: number | null = null;
        if (f.term_months && f.term_months > other.max_term) {
            text += ` (срок до ${monthsText(other.max_term)})`;
        } else if (
            f.amount &&
            f.term_months &&
            !REVOLVING_KINDS.has(product.kind) &&
            !REVOLVING_KINDS.has(other.kind)
        ) {
            // Та же сумма и срок: насколько меньше переплата за весь срок (только для кредитов с графиком)
            const [, current] = offerFigures(product, f.amount, rate, f.term_months);
            const [, otherOver] = offerFigures(other, f.amount, otherRate, f.term_months);
            saving = current > otherOver ? money(current - otherOver) : null;
        }
        hints.push({
            kind: 'product',
            text,
            product_code: other.code,
            product_name: other.name,
            rate: otherRate,
            saving,
        });
    }
    if (riskMargin > 0) {
        const causes = factorCauses(factors);
        const text = causes.length
            ? `Надбавка за риск ${pp(riskMargin)}\u00a0п.п. станет ниже, когда ${causes.join(' и ')}`
            : `Надбавка за риск ${pp(riskMargin)}\u00a0п.п. снижается по мере роста срока работы бизнеса и накопления кредитной истории без просрочек`;
        hints.push({ kind: 'risk', text, product_code: null, product_name: null, rate: null, saving: null });
    }
    return hints;
}

/** «Вам может подойти» после отказа по условиям продукта или лимиту: продукты под ту же цель и доступная сумма. */
export function declineAlternatives(
    product: ProductTerms,
    f: Features,
    { riskMargin, purpose, term_months }: { riskMargin: number; purpose: string | null; term_months: number },
): Alternative[] {
    const result: Alternative[] = [];
    for (const other of byBaseRate()) {
        if (other.code === product.code || other.collateral_required || other.always_manual) continue;
        if (!fitsPurpose(other.code, purpose)) continue;
        const issues = eligibilityIssues(other, {
            business_months: f.business_months,
            is_bank_client: f.is_bank_client,
            account_months: f.account_months,
        });
        if (issues.length) continue;
        const rate = money(other.base_rate + riskMargin);
        const term = Math.min(Math.max(term_months, other.min_term), other.max_term);
        const limit = computeLimit(other, f, { rate, term_months: term, collateral_value: null });
        if (limit.limit === null || limit.limit < other.min_amount) continue;
        result.push({
            product_code: other.code,
            product_name: other.name,
            max_amount: Math.min(limit.limit, other.max_amount),
            term_months: term,
            rate,
        });
    }
    return result.slice(0, 2);
}

/**
 * Что поможет после отказа: по одному совету на код, без повторов. Совет по оценке риска (S05, R01) — по
 * отрицательным факторам скоринга заявки, общий текст — если их нет; при стоп-факторах S01–S04 его нет.
 */
export function nextSteps(
    stopFactors: string[],
    reasonCodes: string[],
    factors: Pick<Factor, 'code' | 'points'>[] = [],
): string[] {
    const blocked = stopFactors.some((code) => BLOCKING_STOP_FACTORS.has(code));
    const causes = factorCauses(factors);
    const result: string[] = [];
    for (const code of [...stopFactors, ...reasonCodes]) {
        let text: string | undefined = ADVICE[code];
        if (RISK_ADVICE_CODES.has(code)) {
            if (blocked) continue;
            if (causes.length) text = riskAdvice(causes);
        }
        if (text && !result.includes(text)) result.push(text);
    }
    return result;
}

/** Проверка решения аналитика по границам полномочий. Возвращает список нарушений. */
export function checkAnalystTerms(
    product: ProductTerms,
    {
        amount,
        term_months,
        rate,
        limit,
        min_rate,
        comment,
    }: {
        amount: number;
        term_months: number;
        rate: number;
        limit: number | null;
        min_rate: number | null;
        comment: string | null;
    },
): string[] {
    const errors: string[] = [];
    if (!(product.min_amount <= amount && amount <= product.max_amount)) {
        errors.push(`Сумма должна быть от ${rub(product.min_amount)} до ${rub(product.max_amount)}`);
    }
    if (!(product.min_term <= term_months && term_months <= product.max_term)) {
        errors.push(`Срок должен быть от ${product.min_term} до ${product.max_term} мес.`);
    }
    if (min_rate !== null && rate < min_rate)
        errors.push(`Ставка не может быть ниже расчётной: ${pp(min_rate)}\u00a0%`);
    if (limit !== null) {
        if (amount > limit * ANALYST_LIMIT_TOLERANCE) {
            errors.push(`Сумма превышает расчётный лимит ${rub(limit)} больше чем на 20\u00a0%`);
        } else if (amount > limit && !(comment && comment.trim())) {
            errors.push('Сумма выше расчётного лимита — добавьте комментарий с обоснованием');
        }
    }
    return errors;
}
