// Обработчик конвейера: шаги проверки, формирование договора и выдача — порт backend/app/pipeline/steps.py
// и worker.py. Внешние системы отвечают данными из снимка настоящего симулятора, сбои включает администратор.
import { AGREEMENT, META, companyProfile, sourceSnapshot } from './data';
import { productTerms } from './engine/catalog';
import { todayUtc } from './engine/dates';
import { buildFeatures, type Features, type Json } from './engine/features';
import { isValidInn } from './engine/inn';
import { FLAGS, POLICY_VERSION, decide, type PolicyDecision } from './engine/policy';
import { SCORING_VERSION, score } from './engine/scoring';
import {
    type AppRow,
    type DecisionRow,
    type DemoState,
    type DemoUser,
    EXTERNAL_STEPS,
    type JobRow,
    PIPELINE_ORDER,
    type StepCode,
    type StepRow,
    iso,
    uuid,
} from './model';
import { jitter, scaled, stepGap } from './timing';
import { emit, enqueue, refresh, transition } from './workflow';

const SECOND = 1000;
const HOUR = 3_600_000;
const OFFER_TTL_HOURS = 7 * 24;
const INFO_REQUEST_TTL_HOURS = 3 * 24;
const SOURCE_WAIT_LIMIT_MS = 15 * 60 * SECOND;
const EXTERNAL_TIMEOUT_MS = 3 * SECOND;
const RETRY_BASE_SECONDS = 2;
const RETRY_MAX_SECONDS = 30;
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 20 * SECOND;

// Задержка ответа как в симуляторе (sim/main.py) и время работы внутренних шагов
const BASE_LATENCY_MS: Record<string, number> = { egrul: 300, fns: 250, girbo: 300, bki: 600, bank: 200, core: 400 };
const INTERNAL_MS: Partial<Record<StepCode, number>> = { DATA_CHECK: 350, GIRBO: 150, SCORING: 350, POLICY: 450 };
const SOURCE_OF: Partial<Record<StepCode, string>> = {
    EGRUL: 'egrul',
    FNS: 'fns',
    GIRBO: 'girbo',
    BKI: 'bki',
    BANK: 'bank',
};

export const retryDelayMs = (attempts: number): number =>
    scaled(Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_SECONDS) * SECOND);

// ---------------------------------------------------------------- внешние системы

interface Breaker {
    failures: number;
    openUntil: number;
}

/** Circuit breaker на каждую внешнюю систему — в памяти, как у обработчика на сервере. */
const breakers = new Map<string, Breaker>();

export const resetBreakers = (): void => breakers.clear();

interface CallResult {
    duration: number;
    ok: boolean;
    error: string | null;
}

function failed(breaker: Breaker, now: number, duration: number, error: string): CallResult {
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_THRESHOLD) {
        breaker.openUntil = now + scaled(BREAKER_OPEN_MS);
        breaker.failures = 0;
    }
    return { duration, ok: false, error };
}

/** Вызов внешней системы: длительность и результат с учётом включённого сбоя. */
function callSource(state: DemoState, source: string, now: number): CallResult {
    const breaker = breakers.get(source) ?? { failures: 0, openUntil: 0 };
    breakers.set(source, breaker);
    if (now < breaker.openUntil) {
        return { duration: scaled(10), ok: false, error: `${source}: вызовы приостановлены после серии ошибок` };
    }
    const fault = state.faults[source] ?? { mode: 'ok', latency_ms: 0 };
    const timeout = `${source}: превышено время ожидания ответа`;
    if (fault.mode === 'error') return failed(breaker, now, jitter(40), `${source}: сервис ответил ошибкой 503`);
    if (fault.mode === 'timeout') return failed(breaker, now, scaled(EXTERNAL_TIMEOUT_MS), timeout);
    const latency = jitter((BASE_LATENCY_MS[source] ?? 300) + (fault.mode === 'slow' ? fault.latency_ms : 0));
    if (latency > scaled(EXTERNAL_TIMEOUT_MS)) return failed(breaker, now, scaled(EXTERNAL_TIMEOUT_MS), timeout);
    breaker.failures = 0;
    return { duration: latency, ok: true, error: null };
}

// ---------------------------------------------------------------- данные заявки

export const findApp = (state: DemoState, id: string): AppRow | undefined =>
    state.applications.find((a) => a.id === id);

export const runSteps = (state: DemoState, app: AppRow): StepRow[] =>
    state.steps.filter((s) => s.app_id === app.id && s.run_no === app.run_no);

function stepRow(state: DemoState, app: AppRow, step: StepCode): StepRow {
    const row = runSteps(state, app).find((s) => s.step === step);
    if (!row) throw new Error(`Нет шага ${step}`);
    return row;
}

export function latestStatement(state: DemoState, app: AppRow): Json | null {
    const documents = state.documents.filter((d) => d.app_id === app.id && d.kind === 'BANK_STATEMENT' && d.parsed);
    documents.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return (documents[0]?.parsed as Json | undefined) ?? null;
}

/** Признаки для скоринга по результатам шагов текущего прогона (collect_inputs). */
export function collectInputs(state: DemoState, app: AppRow, now: number): Features {
    const rows = runSteps(state, app);
    const result = (code: StepCode): Json | null => {
        const row = rows.find((r) => r.step === code);
        return row && (row.status === 'DONE' || row.status === 'SKIPPED') ? row.result : null;
    };
    const unavailable = PIPELINE_ORDER.filter(
        (code) => EXTERNAL_STEPS.has(code) && rows.find((r) => r.step === code)?.status === 'FAILED',
    );
    return buildFeatures({
        today: todayUtc(now),
        amount: app.amount,
        term_months: app.term_months,
        declared_revenue: app.declared_revenue || null,
        egrul: result('EGRUL'),
        fns: result('FNS'),
        girbo: result('GIRBO'),
        bki: result('BKI'),
        bank: result('BANK'),
        statement: latestStatement(state, app),
        unavailable_sources: unavailable,
    });
}

export function saveDecision(
    state: DemoState,
    app: AppRow,
    d: PolicyDecision,
    now: number,
    { kind, user = null, comment = null }: { kind: 'AUTO' | 'MANUAL'; user?: DemoUser | null; comment?: string | null },
): DecisionRow {
    state.seq.decision += 1;
    const decision: DecisionRow = {
        id: state.seq.decision,
        app_id: app.id,
        run_no: app.run_no,
        kind,
        outcome: d.outcome,
        policy_version: d.policy_version,
        limit: d.limit,
        limit_binding: d.limit_binding,
        product_code: app.product_code,
        rate: d.rate,
        stop_factors: d.stop_factors,
        flags: d.flags,
        reason_codes: d.reason_codes,
        trace: d.trace,
        comment,
        decided_by: user?.id ?? null,
        created_at: iso(now),
    };
    state.decisions.push(decision);
    return decision;
}

// ---------------------------------------------------------------- шаги

interface StepOutcome {
    status: 'DONE' | 'SKIPPED';
    result: Json;
}

const isIp = (app: AppRow, now: number): boolean =>
    companyProfile(app.company_id, todayUtc(now), null).legal_form === 'IP';

function snapshot(app: AppRow, code: StepCode, now: number): StepOutcome {
    const data = sourceSnapshot(app.company_id, code, todayUtc(now));
    if (!data) throw new Error(`Нет ответа источника ${code}`);
    return data;
}

const HANDLERS: Record<StepCode, (state: DemoState, app: AppRow, now: number) => StepOutcome> = {
    DATA_CHECK(state, app, now) {
        const product = productTerms(app.product_code);
        const company = companyProfile(app.company_id, todayUtc(now), null);
        const checks = [
            { title: 'ИНН корректен', ok: isValidInn(company.inn) },
            { title: 'Продукт доступен', ok: Boolean(product) },
            {
                title: 'Сумма в пределах продукта',
                ok: Boolean(product && product.min_amount <= app.amount && app.amount <= product.max_amount),
            },
            {
                title: 'Срок в пределах продукта',
                ok: Boolean(product && product.min_term <= app.term_months && app.term_months <= product.max_term),
            },
            { title: 'Согласие на запрос в БКИ', ok: app.consents },
            { title: 'Согласие на обработку персональных данных', ok: app.consents },
        ];
        if (product?.collateral_required) checks.push({ title: 'Указан залог', ok: Boolean(app.collateral_value) });
        const failed = checks.filter((c) => !c.ok).map((c) => c.title);
        if (failed.length) {
            transition(state, app, 'MANUAL_REVIEW', now, {
                actor: 'SYSTEM',
                reason: `Данные заявки требуют проверки: ${failed.join(', ')}`,
            });
            return { status: 'DONE', result: { checks, stopped: true } };
        }
        return { status: 'DONE', result: { checks } };
    },
    EGRUL(state, app, now) {
        state.synced_at[app.company_id] = iso(now);
        return snapshot(app, 'EGRUL', now);
    },
    FNS: (_state, app, now) => snapshot(app, 'FNS', now),
    GIRBO(_state, app, now) {
        if (isIp(app, now)) {
            return {
                status: 'SKIPPED',
                result: {
                    available: false,
                    reason: 'Индивидуальные предприниматели не сдают бухгалтерскую отчётность',
                },
            };
        }
        return snapshot(app, 'GIRBO', now);
    },
    BKI: (_state, app, now) => snapshot(app, 'BKI', now),
    BANK: (_state, app, now) => snapshot(app, 'BANK', now),
    SCORING(state, app, now) {
        const features = collectInputs(state, app, now);
        const result = score(features);
        state.seq.scoring += 1;
        state.scorings.push({
            id: state.seq.scoring,
            app_id: app.id,
            run_no: app.run_no,
            score: result.score,
            risk_class: result.risk_class,
            pd: result.pd,
            version: SCORING_VERSION,
            features: features as unknown as Json,
            factors: result.factors,
            created_at: iso(now),
        });
        return {
            status: 'DONE',
            result: { score: result.score, risk_class: result.risk_class, version: SCORING_VERSION },
        };
    },
    POLICY(state, app, now) {
        const features = collectInputs(state, app, now);
        const product = productTerms(app.product_code)!;
        const d = decide(product, features, score(features), {
            amount: app.amount,
            term_months: app.term_months,
            collateral_value: app.collateral_value || null,
        });
        const decision = saveDecision(state, app, d, now, { kind: 'AUTO' });
        if (d.outcome === 'REJECT') {
            transition(state, app, 'REJECTED', now, {
                actor: 'SYSTEM',
                reason: [...d.stop_factors, ...d.reason_codes].join(', '),
            });
        } else if (d.outcome === 'NEED_INFO') {
            state.info_requests.push({
                id: uuid(),
                app_id: app.id,
                origin: 'SYSTEM',
                requested_by: null,
                items: d.info_items,
                comment: 'Чтобы оценить выручку, нам не хватает данных о поступлениях на счёт.',
                due_at: iso(now + INFO_REQUEST_TTL_HOURS * HOUR),
                status: 'OPEN',
                answer_text: null,
                answered_at: null,
                created_at: iso(now),
            });
            transition(state, app, 'NEED_INFO', now, { actor: 'SYSTEM', reason: 'Нет данных о выручке' });
        } else if (d.outcome === 'MANUAL_REVIEW') {
            const reason =
                d.flags.map((code) => `${code} ${FLAGS[code]}`).join(', ') || 'Продукт рассматривает аналитик';
            transition(state, app, 'MANUAL_REVIEW', now, { actor: 'SYSTEM', reason });
        } else {
            d.options.forEach((option, index) => {
                state.offers.push({
                    id: uuid(),
                    app_id: app.id,
                    decision_id: decision.id,
                    option_no: index + 1,
                    kind: option.kind,
                    product_code: option.product_code,
                    amount: option.amount,
                    term_months: option.term_months,
                    rate: option.rate,
                    monthly_payment: option.monthly_payment,
                    overpayment: option.overpayment,
                    valid_until: iso(now + OFFER_TTL_HOURS * HOUR),
                    status: 'ACTIVE',
                    note: option.note,
                    created_at: iso(now),
                });
            });
            transition(state, app, 'OFFER', now, {
                actor: 'SYSTEM',
                reason: d.outcome === 'APPROVE' ? 'Одобрено автоматически' : 'Контрпредложение',
            });
        }
        return {
            status: 'DONE',
            result: {
                outcome: d.outcome,
                limit: d.limit || null,
                flags: d.flags,
                stop_factors: d.stop_factors,
                version: POLICY_VERSION,
            },
        };
    },
};

// ---------------------------------------------------------------- задания

const drop = (state: DemoState, job: JobRow): void => {
    state.jobs = state.jobs.filter((j) => j.id !== job.id);
};

function startWork(job: JobRow, now: number, call: CallResult): void {
    job.status = 'RUNNING';
    job.run_at = now + call.duration;
    job.outcome = { ok: call.ok, error: call.error };
}

function startStep(state: DemoState, job: JobRow, now: number): void {
    const app = findApp(state, job.app_id);
    const code = job.step as StepCode;
    if (!app || job.run_no !== app.run_no) return drop(state, job);
    if (app.status === 'SUBMITTED') transition(state, app, 'IN_PROCESSING', now, { actor: 'SYSTEM' });
    if (app.status !== 'IN_PROCESSING') return drop(state, job);
    const row = stepRow(state, app, code);
    const source = SOURCE_OF[code];
    const external = source !== undefined && !(code === 'GIRBO' && isIp(app, now));
    const call = external
        ? callSource(state, source, now)
        : { duration: jitter(INTERNAL_MS[code] ?? 300), ok: true, error: null };
    startWork(job, now, call);
    // Первая попытка видна как «выполняется»; повторы идут, пока шаг показан как «ожидание»
    if (row.waiting_since === null) {
        row.status = 'RUNNING';
        row.started_at ??= iso(now);
        refresh(state, app, now, 'PIPELINE_STEP');
    }
}

function handleUnavailable(state: DemoState, app: AppRow, row: StepRow, job: JobRow, error: string, now: number): void {
    const firstWait = row.waiting_since === null;
    row.waiting_since ??= iso(now);
    row.error = error;
    const title = META.steps[row.step].title;
    if (now - Date.parse(row.waiting_since) > scaled(SOURCE_WAIT_LIMIT_MS)) {
        // Ждать дальше нельзя: шаг неуспешный, заявка уйдёт к аналитику с флагом F05.
        row.status = 'FAILED';
        row.finished_at = iso(now);
        emit(state, app, now, {
            audience: 'BANK',
            kind: 'SOURCE_FAILED',
            title: `Источник недоступен по заявке № ${app.number}`,
            body: `${title}: ${error}`,
        });
        drop(state, job);
        const next = PIPELINE_ORDER[PIPELINE_ORDER.indexOf(row.step) + 1];
        enqueue(state, 'PIPELINE_STEP', app, now, next, stepGap());
        return;
    }
    row.status = 'WAITING';
    const delay = retryDelayMs(row.attempts);
    row.next_retry_at = iso(now + delay);
    job.status = 'QUEUED';
    job.run_at = now + delay;
    job.last_error = error;
    job.outcome = null;
    if (firstWait) {
        emit(state, app, now, {
            audience: 'BANK',
            kind: 'SOURCE_WAITING',
            title: `Ожидание внешнего источника по заявке № ${app.number}`,
            body: `${title}: ${error}`,
            notify: false,
        });
    }
    refresh(state, app, now, 'PIPELINE_STEP');
}

function finishStep(state: DemoState, job: JobRow, now: number): void {
    const app = findApp(state, job.app_id);
    const code = job.step as StepCode;
    if (!app || job.run_no !== app.run_no || app.status !== 'IN_PROCESSING') return drop(state, job);
    const row = stepRow(state, app, code);
    row.attempts += 1;
    if (!job.outcome?.ok) return handleUnavailable(state, app, row, job, job.outcome?.error ?? 'нет ответа', now);
    const outcome = HANDLERS[code](state, app, now);
    row.status = outcome.status;
    row.result = outcome.result;
    row.error = null;
    row.next_retry_at = null;
    row.finished_at = iso(now);
    refresh(state, app, now, 'PIPELINE_STEP');
    drop(state, job);
    if (app.status !== 'IN_PROCESSING') return;
    const next = PIPELINE_ORDER[PIPELINE_ORDER.indexOf(code) + 1];
    if (next) enqueue(state, 'PIPELINE_STEP', app, now, next, stepGap());
}

const acceptedOffer = (state: DemoState, app: AppRow) =>
    state.offers.find((o) => o.app_id === app.id && o.status === 'ACCEPTED');

function finishDocuments(state: DemoState, job: JobRow, now: number): void {
    const app = findApp(state, job.app_id);
    drop(state, job);
    if (!app || app.status !== 'ACCEPTED' || !acceptedOffer(state, app)) return;
    // Договор — образец настоящего PDF со стенда (public/demo/agreement-sample.pdf)
    state.documents.push({
        id: uuid(),
        app_id: app.id,
        kind: 'AGREEMENT',
        source: 'GENERATED',
        file_name: `Кредитный договор ${app.number}.pdf`,
        content_type: 'application/pdf',
        size: AGREEMENT.size,
        sha256: AGREEMENT.sha256,
        created_at: iso(now),
        info_request_id: null,
        parsed: null,
        uploaded_by: null,
    });
    transition(state, app, 'SIGNING', now, { actor: 'SYSTEM' });
}

function finishDisburse(state: DemoState, job: JobRow, now: number): void {
    const app = findApp(state, job.app_id);
    const offer = app && acceptedOffer(state, app);
    if (!app || app.status !== 'SIGNED' || !offer) return drop(state, job);
    if (!job.outcome?.ok) {
        const error = job.outcome?.error ?? 'нет ответа';
        job.status = 'QUEUED';
        job.run_at = now + retryDelayMs(job.attempts);
        job.last_error = error;
        job.outcome = null;
        if (job.attempts === 3) {
            emit(state, app, now, {
                audience: 'BANK',
                kind: 'DISBURSE_RETRY',
                title: `Повторяем выдачу по заявке № ${app.number}`,
                body: error,
            });
        }
        return;
    }
    const digits = app.number.replace(/\D/g, '');
    const account = `45207810${digits.slice(-12).padStart(12, '0')}`;
    state.loans.push({
        id: uuid(),
        app_id: app.id,
        offer_id: offer.id,
        product_code: offer.product_code,
        account_number: account,
        amount: offer.amount,
        rate: offer.rate,
        term_months: offer.term_months,
        monthly_payment: offer.monthly_payment,
        issued_at: iso(now),
    });
    drop(state, job);
    transition(state, app, 'ISSUED', now, { actor: 'SYSTEM', reason: `Кредит выдан на счёт ${account}` });
}

/** Один шаг обработчика по заданию: начать работу или применить её результат. */
export function runJob(state: DemoState, job: JobRow, now: number): void {
    job.attempts += job.status === 'QUEUED' ? 1 : 0;
    if (job.kind === 'PIPELINE_STEP') {
        if (job.status === 'QUEUED') startStep(state, job, now);
        else finishStep(state, job, now);
        return;
    }
    const app = findApp(state, job.app_id);
    if (job.kind === 'GENERATE_DOCS') {
        if (job.status === 'RUNNING') return finishDocuments(state, job, now);
        if (!app || app.status !== 'ACCEPTED') return drop(state, job);
        return startWork(job, now, { duration: jitter(900), ok: true, error: null });
    }
    if (job.status === 'RUNNING') return finishDisburse(state, job, now);
    if (!app || app.status !== 'SIGNED') return drop(state, job);
    startWork(job, now, callSource(state, 'core', now));
}

/**
 * Следующее задание. Обработчик один, как на стенде: пока идёт работа (например, ждём ответа внешней
 * системы), остальные задания ждут — поэтому заявки идут по конвейеру по очереди, шаг за шагом.
 */
export function nextJob(state: DemoState): JobRow | undefined {
    const running = state.jobs.filter((job) => job.status === 'RUNNING');
    return (running.length ? running : state.jobs).reduce<JobRow | undefined>(
        (best, job) =>
            !best || job.run_at < best.run_at || (job.run_at === best.run_at && job.id < best.id) ? job : best,
        undefined,
    );
}

/**
 * Выполнить задания, срок которых наступил к моменту now. Время шага — назначенное: если вкладка была
 * закрыта, конвейер «доработал» за это время, как работал бы сервер.
 */
let workerClock = 0;

export function runDueJob(state: DemoState, now: number): boolean {
    const job = nextJob(state);
    if (!job || job.run_at > now) return false;
    // задание не начнётся раньше, чем обработчик освободится от предыдущего
    const at = Math.min(Math.max(job.run_at, workerClock), now);
    runJob(state, job, at);
    workerClock = at;
    return true;
}

/** Мгновенно довести все задания до конца, отсчитывая время от start (для стартовых демо-данных). */
export function drain(state: DemoState, start: number): number {
    let clock = start;
    for (let guard = 0; guard < 500; guard += 1) {
        const job = nextJob(state);
        if (!job) break;
        clock = Math.max(clock, job.run_at);
        runJob(state, job, clock);
    }
    return clock;
}

/** Таймеры процесса: истечение предложений и запросов информации (sweep обработчика). */
export function sweep(state: DemoState, now: number): boolean {
    let changed = false;
    for (const app of state.applications.filter((a) => a.status === 'OFFER')) {
        const offers = state.offers.filter((o) => o.app_id === app.id && o.status === 'ACTIVE');
        if (offers.length && offers.every((o) => Date.parse(o.valid_until) < now)) {
            offers.forEach((o) => {
                o.status = 'EXPIRED';
            });
            transition(state, app, 'EXPIRED', now, { actor: 'SYSTEM', reason: 'Истёк срок предложения' });
            changed = true;
        }
    }
    for (const request of state.info_requests.filter((r) => r.status === 'OPEN' && Date.parse(r.due_at) < now)) {
        request.status = 'EXPIRED';
        const app = findApp(state, request.app_id);
        if (app && app.status === 'NEED_INFO') {
            transition(state, app, 'EXPIRED', now, { actor: 'SYSTEM', reason: 'Истёк срок ответа на запрос' });
        }
        changed = true;
    }
    return changed;
}

export const hasExpired = (state: DemoState, now: number): boolean =>
    state.info_requests.some((r) => r.status === 'OPEN' && Date.parse(r.due_at) < now) ||
    state.applications.some(
        (a) =>
            a.status === 'OFFER' &&
            state.offers.some((o) => o.app_id === a.id && o.status === 'ACTIVE') &&
            state.offers
                .filter((o) => o.app_id === a.id && o.status === 'ACTIVE')
                .every((o) => Date.parse(o.valid_until) < now),
    );
