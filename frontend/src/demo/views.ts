// Ответы API из данных имитации — порт backend/app/services/views.py и сборки ответов в api/*.py.
import type {
    Application,
    ApplicationListItem,
    AuditRow,
    AnalystMetrics,
    BankMetrics,
    BankSummary,
    DailyMetrics,
    MetricCount,
    ProactiveOffers,
    ProductMetrics,
    Purpose,
    Company,
    DecisionView,
    DocumentItem,
    Dossier,
    Explanation,
    HistoryItem,
    InfoRequest,
    Loan,
    Notifications,
    Offer,
    PipelineIssue,
    QueueItem,
    Step,
    TermsPreview,
    User,
} from '../api/types';
import { META, USERS, companyProfile, sourceSnapshot, userName } from './data';
import { PRODUCTS, productRow, productTerms } from './engine/catalog';
import { todayUtc } from './engine/dates';
import { buildFeatures } from './engine/features';
import { paymentSchedule } from './engine/finance';
import { TYPICAL_TERM, proactiveFacts, proactiveNote, proactiveOffers } from './engine/proactive';
import {
    LIMIT_PHRASES,
    type LimitResult,
    REASONS,
    STOP_FACTORS,
    checkAnalystTerms,
    computeLimit,
    eligibilityIssues,
    offerFigures,
    paymentLabel,
    rateFor,
} from './engine/policy';
import { score } from './engine/scoring';
import { HttpError } from './http';
import {
    CANCELLABLE,
    PIPELINE_ORDER,
    iso,
    type AppRow,
    type DecisionRow,
    type DemoState,
    type DemoUser,
    type EventRow,
} from './model';
import { collectInputs, runSteps } from './pipeline';

/** Деньги в ответах — строкой с копейками, как Decimal из базы. */
export const money = (value: number): string => value.toFixed(2);
const moneyOrNull = (value: number | null): string | null => (value === null ? null : money(value));
const rate = (value: number): string => value.toFixed(2);

const CLIENT_ACTION_STATUSES = new Set(['DRAFT', 'NEED_INFO', 'OFFER', 'SIGNING']);
export const ACTIVE = [
    'SUBMITTED',
    'IN_PROCESSING',
    'NEED_INFO',
    'MANUAL_REVIEW',
    'OFFER',
    'ACCEPTED',
    'SIGNING',
    'SIGNED',
];

const isClient = (viewer: DemoUser) => viewer.role === 'CLIENT';

export const companyOut = (state: DemoState, companyId: string, now: number): Company =>
    companyProfile(companyId, todayUtc(now), state.synced_at[companyId] ?? null);

export const userOut = (state: DemoState, user: DemoUser, now: number): User => ({
    id: user.id,
    login: user.login,
    full_name: user.full_name,
    position: user.position,
    role: user.role,
    can_sign: user.can_sign,
    company: user.company_id ? companyOut(state, user.company_id, now) : null,
});

const byId = <T extends { id: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id - b.id);

export const latestScoring = (state: DemoState, app: AppRow) =>
    byId(state.scorings.filter((s) => s.app_id === app.id)).at(-1) ?? null;

export const latestDecision = (state: DemoState, app: AppRow): DecisionRow | null =>
    byId(state.decisions.filter((d) => d.app_id === app.id)).at(-1) ?? null;

function offerOut(offer: AppOffer): Offer {
    const product = productRow(offer.product_code);
    return {
        id: offer.id,
        option_no: offer.option_no,
        kind: offer.kind,
        product_code: offer.product_code,
        product_name: product?.name ?? offer.product_code,
        product_kind: product?.kind ?? 'LOAN',
        amount: money(offer.amount),
        term_months: offer.term_months,
        rate: rate(offer.rate),
        monthly_payment: money(offer.monthly_payment),
        overpayment: money(offer.overpayment),
        payment_label: paymentLabel(product?.kind ?? 'LOAN'),
        valid_until: offer.valid_until,
        status: offer.status,
        note: offer.note,
    };
}

type AppOffer = DemoState['offers'][number];

function stepsOut(state: DemoState, app: AppRow, includeErrors: boolean): Step[] {
    const rows = runSteps(state, app);
    return PIPELINE_ORDER.flatMap((code) => {
        const row = rows.find((r) => r.step === code);
        if (!row) return [];
        const waiting = row.status === 'WAITING' || row.status === 'RUNNING' ? META.steps[code].waiting : null;
        return [
            {
                step: code,
                title: META.steps[code].title,
                status: row.status,
                attempts: row.attempts,
                started_at: row.started_at,
                finished_at: row.finished_at,
                next_retry_at: row.next_retry_at,
                waiting_text: waiting,
                error: includeErrors ? row.error : null,
            },
        ];
    });
}

export function documentsOut(state: DemoState, app: AppRow): DocumentItem[] {
    const signatures = state.signatures.filter((s) => s.app_id === app.id);
    const signed = (id: string, role: string) => signatures.some((s) => s.document_id === id && s.signer_role === role);
    return state.documents
        .filter((d) => d.app_id === app.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((d) => ({
            id: d.id,
            kind: d.kind,
            kind_label: META.documents[d.kind] ?? d.kind,
            source: d.source,
            file_name: d.file_name,
            content_type: d.content_type,
            size: d.size,
            sha256: d.sha256,
            created_at: d.created_at,
            info_request_id: d.info_request_id,
            parsed: d.kind === 'BANK_STATEMENT' ? d.parsed : null,
            signed_by_client: signed(d.id, 'CLIENT'),
            signed_by_bank: signed(d.id, 'BANK'),
        }));
}

function historyOut(state: DemoState, app: AppRow, viewer: DemoUser): HistoryItem[] {
    const side = isClient(viewer) ? 'client' : 'bank';
    return byId(state.history.filter((h) => h.app_id === app.id)).map((h) => ({
        from_status: h.from_status,
        to_status: h.to_status,
        to_label: META.statuses[h.to_status][side],
        actor: h.actor,
        actor_name: userName(h.actor_user_id),
        reason: isClient(viewer) ? null : h.reason,
        created_at: h.created_at,
    }));
}

/** Что повлияло на решение — простыми словами (docs/credit-policy.md, «Объяснение решения клиенту»). */
export function explanation(state: DemoState, app: AppRow): Explanation {
    const out: Explanation = { positive: [], negative: [], limit_phrase: null, rejection: [], advice: [] };
    const scoring = latestScoring(state, app);
    const decision = latestDecision(state, app);
    if (scoring) {
        const positive = scoring.factors.filter((f) => f.points > 0).sort((a, b) => b.points - a.points);
        const negative = scoring.factors.filter((f) => f.points < 0).sort((a, b) => a.points - b.points);
        out.positive = positive.slice(0, 3).map((f) => f.phrase as string);
        out.negative = negative.slice(0, 2).map((f) => f.phrase as string);
    }
    if (decision) {
        if (decision.limit_binding && (decision.outcome === 'COUNTER' || decision.outcome === 'APPROVE')) {
            out.limit_phrase = LIMIT_PHRASES[decision.limit_binding] ?? null;
        }
        if (app.status === 'REJECTED') {
            out.rejection = decision.stop_factors.filter((code) => code !== 'S05').map((code) => STOP_FACTORS[code]);
            for (const code of decision.reason_codes) {
                out.rejection.push(code === 'R07' && decision.comment ? decision.comment : REASONS[code].client);
            }
            if (!out.rejection.length) out.rejection = [STOP_FACTORS.S05];
            out.advice = out.negative;
        }
    }
    return out;
}

export function loanOut(state: DemoState, app: AppRow): Loan | null {
    const loan = state.loans.find((l) => l.app_id === app.id);
    if (!loan) return null;
    return {
        id: loan.id,
        product_code: loan.product_code,
        account_number: loan.account_number,
        amount: money(loan.amount),
        rate: rate(loan.rate),
        term_months: loan.term_months,
        monthly_payment: money(loan.monthly_payment),
        issued_at: loan.issued_at,
        schedule: paymentSchedule(loan.amount, loan.rate, loan.term_months, loan.issued_at.slice(0, 10)).map((row) => ({
            n: row.n,
            due_date: row.due_date,
            payment: money(row.payment),
            principal: money(row.principal),
            interest: money(row.interest),
            balance: money(row.balance),
        })),
    };
}

const infoRequestOut = (r: DemoState['info_requests'][number]): InfoRequest => ({
    id: r.id,
    origin: r.origin,
    items: r.items,
    comment: r.comment,
    due_at: r.due_at,
    status: r.status,
    answer_text: r.answer_text,
    answered_at: r.answered_at,
    created_at: r.created_at,
});

export function applicationOut(state: DemoState, app: AppRow, viewer: DemoUser, now: number): Application {
    const side = isClient(viewer) ? 'client' : 'bank';
    let offers = state.offers
        .filter((o) => o.app_id === app.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.option_no - b.option_no);
    if (app.status === 'OFFER') offers = offers.filter((o) => o.status === 'ACTIVE');
    else {
        const accepted = offers.filter((o) => o.status === 'ACCEPTED');
        offers = accepted.length ? accepted : offers.filter((o) => o.status === 'DECLINED' || o.status === 'EXPIRED');
    }
    const product = productRow(app.product_code);
    if (!product) throw new HttpError(500, 'Нет продукта');
    return {
        id: app.id,
        number: app.number,
        status: app.status,
        status_label: META.statuses[app.status][side],
        next_step: META.statuses[app.status].next,
        needs_action: CLIENT_ACTION_STATUSES.has(app.status),
        can_cancel: CANCELLABLE.has(app.status),
        product,
        purpose: app.purpose,
        purpose_label: META.purposes[app.purpose] ?? app.purpose,
        purpose_text: app.purpose_text,
        amount: money(app.amount),
        term_months: app.term_months,
        declared_revenue: moneyOrNull(app.declared_revenue),
        collateral_type: app.collateral_type,
        collateral_value: moneyOrNull(app.collateral_value),
        created_at: app.created_at,
        submitted_at: app.submitted_at,
        status_changed_at: app.status_changed_at,
        closed_at: app.closed_at,
        run_no: app.run_no,
        company: companyOut(state, app.company_id, now),
        steps: stepsOut(state, app, !isClient(viewer)),
        offers: offers.map(offerOut),
        info_requests: state.info_requests
            .filter((r) => r.app_id === app.id)
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map(infoRequestOut),
        documents: documentsOut(state, app),
        history: historyOut(state, app, viewer),
        explanation: explanation(state, app),
        loan: loanOut(state, app),
        ai_parsed: app.ai_parsed,
    };
}

export function listItem(app: AppRow): ApplicationListItem {
    const product = productRow(app.product_code);
    return {
        id: app.id,
        number: app.number,
        status: app.status,
        status_label: META.statuses[app.status].client,
        product_code: app.product_code,
        product_name: product?.name ?? app.product_code,
        amount: money(app.amount),
        term_months: app.term_months,
        created_at: app.created_at,
        status_changed_at: app.status_changed_at,
        needs_action: CLIENT_ACTION_STATUSES.has(app.status),
    };
}

// ---------------------------------------------------------------- рабочее место банка

function waitingSource(state: DemoState, app: AppRow): string | null {
    if (app.status !== 'IN_PROCESSING') return null;
    const row = runSteps(state, app).find((s) => s.status === 'WAITING');
    return row ? META.steps[row.step].title : null;
}

export function queueItems(
    state: DemoState,
    viewer: DemoUser,
    now: number,
    filters: {
        status: string[];
        product: string | null;
        risk_class: string | null;
        mine: boolean;
        q: string | null;
        include_closed: boolean;
    },
): QueueItem[] {
    let rows = state.applications;
    if (filters.status.length) rows = rows.filter((a) => filters.status.includes(a.status));
    else if (!filters.include_closed) rows = rows.filter((a) => ACTIVE.includes(a.status));
    else rows = rows.filter((a) => a.status !== 'DRAFT');
    if (filters.product) rows = rows.filter((a) => a.product_code === filters.product);
    if (filters.mine) rows = rows.filter((a) => a.assignee_id === viewer.id);
    const q = filters.q?.trim();
    if (q) {
        rows = rows.filter((a) => {
            const company = companyOut(state, a.company_id, now);
            return (
                company.name.toLowerCase().includes(q.toLowerCase()) || company.inn.includes(q) || a.number.includes(q)
            );
        });
    }
    rows = [...rows].sort((a, b) => b.status_changed_at.localeCompare(a.status_changed_at)).slice(0, 300);

    const items: QueueItem[] = [];
    for (const a of rows) {
        const scoring = latestScoring(state, a);
        const decision = latestDecision(state, a);
        if (filters.risk_class && scoring?.risk_class !== filters.risk_class) continue;
        const company = companyOut(state, a.company_id, now);
        const review = a.status === 'MANUAL_REVIEW';
        items.push({
            id: a.id,
            number: a.number,
            company_name: company.name,
            inn: company.inn,
            legal_form: company.legal_form,
            product_code: a.product_code,
            product_name: productRow(a.product_code)?.name ?? a.product_code,
            amount: money(a.amount),
            term_months: a.term_months,
            status: a.status,
            status_label: META.statuses[a.status].bank,
            risk_class: scoring?.risk_class ?? null,
            score: scoring?.score ?? null,
            flags: decision?.flags ?? [],
            assignee_name: userName(a.assignee_id),
            assignee_is_me: a.assignee_id === viewer.id,
            sla_due_at: review ? a.sla_due_at : null,
            overdue: Boolean(review && a.sla_due_at && Date.parse(a.sla_due_at) < now),
            submitted_at: a.submitted_at,
            status_changed_at: a.status_changed_at,
            waiting_source: waitingSource(state, a),
        });
    }
    const priority: Record<string, number> = { MANUAL_REVIEW: 0, IN_PROCESSING: 1, NEED_INFO: 2 };
    return items.sort(
        (a, b) =>
            (priority[a.status] ?? 3) - (priority[b.status] ?? 3) ||
            (a.sla_due_at ?? a.status_changed_at).localeCompare(b.sla_due_at ?? b.status_changed_at),
    );
}

export function bankSummary(state: DemoState, viewer: DemoUser, now: number): BankSummary {
    const apps = state.applications;
    const count = (test: (a: AppRow) => boolean) => apps.filter(test).length;
    const midnight = Date.parse(`${todayUtc(now)}T00:00:00Z`);
    return {
        manual_review: count((a) => a.status === 'MANUAL_REVIEW'),
        mine: count((a) => a.status === 'MANUAL_REVIEW' && a.assignee_id === viewer.id),
        overdue: count((a) => a.status === 'MANUAL_REVIEW' && Boolean(a.sla_due_at) && Date.parse(a.sla_due_at!) < now),
        need_info: count((a) => a.status === 'NEED_INFO'),
        in_processing: count((a) => a.status === 'SUBMITTED' || a.status === 'IN_PROCESSING'),
        waiting_sources: count((a) => waitingSource(state, a) !== null),
        offers: count((a) => a.status === 'OFFER'),
        issued_today: count(
            (a) => a.status === 'ISSUED' && Boolean(a.closed_at) && Date.parse(a.closed_at!) >= midnight,
        ),
    };
}

/**
 * Ограничения лимита. Если лимит не рассчитан (нет данных о выручке), сервер отдаёт суммы строками —
 * Decimal без преобразования в число; повторяем это, интерфейс понимает оба вида.
 */
function constraintsOut(result: LimitResult): TermsPreview['constraints'] {
    if (result.limit !== null) return result.constraints;
    return result.constraints.map((c) => ({ ...c, amount: money(c.amount) as unknown as number }));
}

function decisionView(d: DecisionRow | null): DecisionView | null {
    if (!d) return null;
    return {
        id: d.id,
        kind: d.kind,
        outcome: d.outcome,
        policy_version: d.policy_version,
        limit: d.limit,
        limit_binding: d.limit_binding,
        rate: d.rate,
        flags: d.flags.map((code) => ({ code, title: META.flags[code] ?? code })),
        stop_factors: d.stop_factors.map((code) => ({ code, title: META.stop_factors[code] ?? code })),
        reason_codes: d.reason_codes,
        trace: d.trace,
        comment: d.comment,
        decided_by: userName(d.decided_by),
        created_at: d.created_at,
    };
}

export function dossierOut(state: DemoState, app: AppRow, viewer: DemoUser, now: number): Dossier {
    const scoring = latestScoring(state, app);
    const auto = byId(state.decisions.filter((d) => d.app_id === app.id && d.kind === 'AUTO')).at(-1) ?? null;
    let limit: Dossier['limit'] = null;
    if (scoring) {
        const features = collectInputs(state, app, now);
        const terms = productTerms(app.product_code)!;
        const minRate = rateFor(terms, score(features));
        if (minRate !== null) {
            const result = computeLimit(terms, features, {
                rate: minRate,
                term_months: app.term_months,
                collateral_value: app.collateral_value || null,
            });
            limit = {
                limit: result.limit,
                binding: result.binding,
                phrase: LIMIT_PHRASES[result.binding ?? ''] ?? null,
                constraints: constraintsOut(result),
                rate: minRate,
            };
        }
    }
    const sources: Dossier['sources'] = {};
    for (const row of runSteps(state, app)) {
        sources[row.step] = {
            status: row.status,
            result: row.result,
            error: row.error,
            attempts: row.attempts,
            finished_at: row.finished_at,
        };
    }
    return {
        application: applicationOut(state, app, viewer, now),
        sources,
        scoring: scoring && {
            score: scoring.score,
            risk_class: scoring.risk_class,
            pd: scoring.pd,
            version: scoring.version,
            factors: scoring.factors,
            features: scoring.features,
        },
        auto_decision: decisionView(auto),
        last_decision: decisionView(latestDecision(state, app)),
        limit,
        assignee: userName(app.assignee_id),
        assignee_is_me: app.assignee_id === viewer.id,
        sla_due_at: app.sla_due_at,
        audit: state.audit
            .filter((r) => r.entity_id === app.id)
            .sort((a, b) => b.id - a.id)
            .slice(0, 100)
            .map((r) => ({
                action: r.action,
                actor: r.actor,
                user: userName(r.actor_user_id),
                details: r.details,
                created_at: r.created_at,
            })),
        info_item_presets: META.info_items,
    };
}

export interface TermsResult {
    preview: TermsPreview;
    rate: number;
    limit: number | null;
    monthly: number;
    over: number;
}

/** Условия для решения аналитика: лимит, ставка, платёж и нарушения полномочий (_terms на сервере). */
export function termsFor(
    state: DemoState,
    app: AppRow,
    now: number,
    request: { product_code: string; amount: number; term_months: number; rate: number | null; comment: string | null },
): TermsResult {
    const terms = productTerms(request.product_code);
    if (!terms) throw new HttpError(422, 'Такого продукта нет');
    const features = collectInputs(state, app, now);
    const minRate = rateFor(terms, score(features));
    const effectiveRate = request.rate || minRate || terms.base_rate + 5;
    const collateral = app.collateral_value || null;
    const limit = computeLimit(terms, features, {
        rate: effectiveRate,
        term_months: request.term_months,
        collateral_value: collateral,
    });
    const errors = eligibilityIssues(terms, {
        business_months: features.business_months,
        is_bank_client: features.is_bank_client,
        account_months: features.account_months,
    }).map((issue) => issue.text);
    if (terms.collateral_required && !collateral) errors.push('Для продукта нужен залог');
    errors.push(
        ...checkAnalystTerms(terms, {
            amount: request.amount,
            term_months: request.term_months,
            rate: effectiveRate,
            limit: limit.limit,
            min_rate: minRate,
            comment: request.comment,
        }),
    );
    const [monthly, over] = offerFigures(terms, request.amount, effectiveRate, request.term_months);
    return {
        preview: {
            limit: moneyOrNull(limit.limit),
            limit_binding: limit.binding,
            limit_phrase: LIMIT_PHRASES[limit.binding ?? ''] ?? null,
            min_rate: minRate === null ? null : rate(minRate),
            rate: request.rate ? String(request.rate) : rate(effectiveRate),
            monthly_payment: money(monthly),
            overpayment: money(over),
            payment_label: paymentLabel(terms.kind),
            errors,
            constraints: constraintsOut(limit),
        },
        rate: effectiveRate,
        limit: limit.limit,
        monthly,
        over,
    };
}

export function pipelineIssues(state: DemoState): PipelineIssue[] {
    const issues: PipelineIssue[] = [];
    for (const app of state.applications.filter((a) => ACTIVE.includes(a.status))) {
        for (const row of runSteps(state, app)) {
            if (
                (row.status === 'WAITING' || row.status === 'FAILED') &&
                (app.status === 'IN_PROCESSING' || row.status === 'FAILED')
            ) {
                issues.push({
                    application_id: app.id,
                    number: app.number,
                    company_name: companyOut(state, app.company_id, Date.now()).name,
                    status: app.status,
                    step: row.step,
                    step_title: META.steps[row.step].title,
                    step_status: row.status,
                    attempts: row.attempts,
                    error: row.error,
                    waiting_since: row.waiting_since,
                    next_retry_at: row.next_retry_at,
                });
            }
        }
    }
    return issues;
}

// ---------------------------------------------------------------- уведомления и журнал

/** События, которые видит пользователь: клиент — по своей компании, банк — банковские и общие. */
export function inScope(event: EventRow, viewer: DemoUser): boolean {
    if (isClient(viewer)) return event.company_id === viewer.company_id && event.audience !== 'BANK';
    return event.audience !== 'CLIENT';
}

export function notificationsOut(state: DemoState, viewer: DemoUser): Notifications {
    const lastRead = state.last_read[viewer.id] ?? 0;
    const visible = state.events.filter((e) => e.notify && inScope(e, viewer)).sort((a, b) => b.id - a.id);
    return {
        unread: visible.filter((e) => e.id > lastRead).length,
        items: visible.slice(0, 50).map((e) => ({
            id: e.id,
            application_id: e.app_id,
            kind: e.kind,
            title: e.title,
            body: e.body,
            created_at: e.created_at,
            unread: e.id > lastRead,
        })),
    };
}

export const auditOut = (state: DemoState): AuditRow[] =>
    [...state.audit]
        .sort((a, b) => b.id - a.id)
        .slice(0, 200)
        .map((r) => ({
            id: r.id,
            action: r.action,
            actor: r.actor,
            user: userName(r.actor_user_id),
            entity_type: r.entity_type,
            entity_id: r.entity_id,
            details: r.details,
            created_at: r.created_at,
        }));

// ---------------------------------------------------------------- показатели конвейера (backend/app/services/metrics.py)

const FINAL_OUTCOMES = new Set(['APPROVE', 'COUNTER', 'REJECT']);
const APPROVED_OUTCOMES = new Set(['APPROVE', 'COUNTER']);
const OUTCOME_TITLES: Record<string, string> = {
    APPROVE: 'Одобрено как запрошено',
    COUNTER: 'Контрпредложение',
    REJECT: 'Отказ',
};
const STOP_FACTOR_TITLES: Record<string, string> = {
    S01: 'Ликвидация, реорганизация или банкротство',
    S02: 'Руководитель дисквалифицирован',
    S03: 'Текущая просрочка больше 30 дней',
    S04: 'Бизнес младше 3 месяцев',
    S05: 'Класс риска E',
};
const DAY_MS = 86_400_000;

const medianOf = (values: number[]): number | null => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentileOf = (values: number[], share: number): number | null => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.round(share * (sorted.length - 1)))];
};
const shareOf = (part: number, whole: number): number | null =>
    whole ? Math.round((part / whole) * 1000) / 1000 : null;
const hoursOf = (seconds: number[]): number | null => {
    const value = medianOf(seconds);
    return value === null ? null : Math.round(value / 360) / 10;
};
const seconds = (later: string, earlier: string): number => (Date.parse(later) - Date.parse(earlier)) / 1000;
const dayOf = (iso: string): string => iso.slice(0, 10);
// Decimal(0) сервер отдаёт как "0", суммы — с копейками
const sumMoney = (total: number): string => (total === 0 ? '0' : money(total));

const countRows = (counter: Map<string, number>, title: (code: string) => string): MetricCount[] =>
    [...counter.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, title: title(code), count }));

const bump = (counter: Map<string, number>, code: string) => counter.set(code, (counter.get(code) ?? 0) + 1);

export function bankMetrics(state: DemoState, now: number, days: number): BankMetrics {
    const since = now - days * DAY_MS;
    const apps = state.applications.filter((a) => a.submitted_at && Date.parse(a.submitted_at) >= since);
    const appIds = new Set(apps.map((a) => a.id));
    const byId = new Map(apps.map((a) => [a.id, a]));
    const decisions = state.decisions.filter((d) => appIds.has(d.app_id)).sort((a, b) => a.id - b.id);
    const offers = state.offers.filter((o) => appIds.has(o.app_id));
    const infoRequests = state.info_requests.filter((r) => appIds.has(r.app_id));
    const reviewHistory = state.history
        .filter((h) => appIds.has(h.app_id) && h.to_status === 'MANUAL_REVIEW')
        .sort((a, b) => a.id - b.id);
    const loans = new Map(state.loans.filter((l) => appIds.has(l.app_id)).map((l) => [l.app_id, l]));

    const firstFinal = new Map<string, DecisionRow>();
    const lastFinal = new Map<string, DecisionRow>();
    for (const d of decisions) {
        if (!FINAL_OUTCOMES.has(d.outcome)) continue;
        if (!firstFinal.has(d.app_id)) firstFinal.set(d.app_id, d);
        lastFinal.set(d.app_id, d);
    }
    const finals = [...lastFinal.values()];
    const auto = finals.filter((d) => d.kind === 'AUTO').length;
    const issued = apps.filter((a) => a.status === 'ISSUED');
    const issuedAmount = issued.reduce((sum, a) => sum + (loans.get(a.id)?.amount ?? 0), 0);

    const toDecision = [...firstFinal.entries()].map(([appId, d]) =>
        seconds(d.created_at, byId.get(appId)!.submitted_at!),
    );
    const toIssue = issued.filter((a) => a.closed_at).map((a) => seconds(a.closed_at!, a.submitted_at!));
    const infoResponse = infoRequests
        .filter((r) => r.status === 'ANSWERED' && r.answered_at)
        .map((r) => seconds(r.answered_at!, r.created_at));
    const reviewSeconds = new Map<string | null, number[]>();
    let breached = 0;
    for (const d of decisions) {
        if (d.kind !== 'MANUAL' || !FINAL_OUTCOMES.has(d.outcome)) continue;
        const starts = reviewHistory.filter((h) => h.app_id === d.app_id && h.created_at <= d.created_at);
        if (starts.length) {
            const list = reviewSeconds.get(d.decided_by) ?? [];
            list.push(seconds(d.created_at, starts[starts.length - 1].created_at));
            reviewSeconds.set(d.decided_by, list);
        }
        const due = byId.get(d.app_id)?.sla_due_at;
        if (due && d.created_at > due) breached += 1;
    }
    const allReview = [...reviewSeconds.values()].flat();

    const offered = new Set(offers.map((o) => o.app_id));
    const accepted = new Set(offers.filter((o) => o.status === 'ACCEPTED').map((o) => o.app_id));
    const counterApps = new Set(
        [...offered].filter((appId) => offers.filter((o) => o.app_id === appId).every((o) => o.kind === 'COUNTER')),
    );
    const counterAccepted = [...counterApps].filter((appId) => accepted.has(appId)).length;

    const reasons = new Map<string, number>();
    const stopFactors = new Map<string, number>();
    for (const d of finals) {
        if (d.outcome !== 'REJECT') continue;
        d.reason_codes.forEach((code) => bump(reasons, code));
        d.stop_factors.forEach((code) => bump(stopFactors, code));
    }
    const reasonTitle = (code: string): string => META.reasons[code]?.bank ?? code;

    const products = new Map<string, ProductMetrics>(
        PRODUCTS.map((p) => [
            p.code,
            { code: p.code, name: p.name, applications: 0, approved: 0, issued: 0, issued_amount: 0 },
        ]),
    );
    for (const a of apps) {
        let row = products.get(a.product_code);
        if (!row) {
            row = {
                code: a.product_code,
                name: a.product_code,
                applications: 0,
                approved: 0,
                issued: 0,
                issued_amount: 0,
            };
            products.set(a.product_code, row);
        }
        row.applications += 1;
        const final = lastFinal.get(a.id);
        if (final && APPROVED_OUTCOMES.has(final.outcome)) row.approved += 1;
        const loan = loans.get(a.id);
        if (a.status === 'ISSUED' && loan) {
            row.issued += 1;
            row.issued_amount = Number(row.issued_amount) + loan.amount;
        }
    }

    const manualNow = apps.filter((a) => a.status === 'MANUAL_REVIEW');
    const analysts: AnalystMetrics[] = USERS.filter((u) => u.role === 'UNDERWRITER')
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
        .map((user) => {
            const inWork = manualNow.filter((a) => a.assignee_id === user.id);
            return {
                name: user.full_name,
                decided: finals.filter((d) => d.kind === 'MANUAL' && d.decided_by === user.id).length,
                in_work: inWork.length,
                overdue: inWork.filter((a) => a.sla_due_at && Date.parse(a.sla_due_at) < now).length,
                median_review_hours: hoursOf(reviewSeconds.get(user.id) ?? []),
            };
        });

    const daily = new Map<string, DailyMetrics>();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const day = dayOf(iso(now - offset * DAY_MS));
        daily.set(day, { date: day, submitted: 0, decided: 0, issued: 0 });
    }
    for (const a of apps) {
        const submitted = daily.get(dayOf(a.submitted_at!));
        if (submitted) submitted.submitted += 1;
        if (a.status === 'ISSUED' && a.closed_at) {
            const row = daily.get(dayOf(a.closed_at));
            if (row) row.issued += 1;
        }
    }
    for (const d of firstFinal.values()) {
        const row = daily.get(dayOf(d.created_at));
        if (row) row.decided += 1;
    }

    const outcomeCounter = new Map<string, number>();
    finals.forEach((d) => bump(outcomeCounter, d.outcome));

    return {
        period_days: days,
        since: iso(since),
        until: iso(now),
        submitted: apps.length,
        in_progress: apps.filter((a) => ACTIVE.includes(a.status)).length,
        decided: finals.length,
        auto_decided: auto,
        manual_decided: finals.length - auto,
        automation_share: shareOf(auto, finals.length),
        manual_review: new Set(reviewHistory.map((h) => h.app_id)).size,
        need_info: new Set(infoRequests.filter((r) => r.origin === 'SYSTEM').map((r) => r.app_id)).size,
        issued: issued.length,
        issued_amount: sumMoney(issuedAmount),
        outcomes: countRows(outcomeCounter, (code) => OUTCOME_TITLES[code] ?? code),
        to_decision_median_seconds: medianOf(toDecision),
        to_decision_p95_seconds: percentileOf(toDecision, 0.95),
        to_issue_median_hours: hoursOf(toIssue),
        info_response_median_hours: hoursOf(infoResponse),
        review_median_hours: hoursOf(allReview),
        offered: offered.size,
        accepted: accepted.size,
        offer_conversion: shareOf(accepted.size, offered.size),
        counter_offered: counterApps.size,
        counter_accepted: counterAccepted,
        counter_conversion: shareOf(counterAccepted, counterApps.size),
        sla_overdue_now: manualNow.filter((a) => a.sla_due_at && Date.parse(a.sla_due_at) < now).length,
        sla_breached: breached,
        rejection_reasons: [
            ...countRows(stopFactors, (code) => STOP_FACTOR_TITLES[code] ?? code),
            ...countRows(reasons, reasonTitle),
        ],
        products: [...products.values()]
            .filter((row) => row.applications)
            .map((row) => ({ ...row, issued_amount: sumMoney(Number(row.issued_amount)) })),
        analysts,
        daily: [...daily.values()],
    };
}

// ---------------------------------------------------------------- предварительные предложения (backend/app/api/catalog.py)

export const PROACTIVE_UNAVAILABLE = 'Внешние источники сейчас недоступны — попробуйте позже';

export function proactiveOffersOut(companyId: string, now: number): ProactiveOffers {
    const today = todayUtc(now);
    const egrul = sourceSnapshot(companyId, 'EGRUL', today)?.result ?? null;
    const bank = sourceSnapshot(companyId, 'BANK', today)?.result ?? null;
    const girbo = egrul?.legal_form === 'OOO' ? (sourceSnapshot(companyId, 'GIRBO', today)?.result ?? null) : null;
    const f = buildFeatures({
        today,
        amount: 0,
        term_months: TYPICAL_TERM,
        declared_revenue: null,
        egrul,
        fns: null,
        girbo,
        bki: null,
        bank,
        statement: null,
    });
    const offers = proactiveOffers(f);
    return {
        offers: offers.map((o) => ({ ...o, purpose: o.purpose as Purpose, payment_label: paymentLabel(o.kind) })),
        facts: proactiveFacts(f),
        note: proactiveNote(f, offers),
        computed_at: iso(now),
    };
}
