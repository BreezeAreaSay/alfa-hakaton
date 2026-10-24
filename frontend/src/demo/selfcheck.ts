// Сверка имитации сервера с настоящим API: проходит те же сценарии, что скрипт съёмки
// (scripts/capture-demo-fixtures.mjs), и сравнивает ответы со снимками в fixtures/. В приложение не входит —
// запускается командой npm run demo:check (scripts/demo-selfcheck.mjs).
import type { Application, Dossier } from '../api/types';
import { DEMO_PASSWORD } from './data';
import { parseNeedRules } from './engine/ai';
import { moscowDate } from './engine/dates';
import { PRIORITY_RANK, reviewPriority } from './engine/review';
import { parseStatement } from './engine/statements';
import aiGolden from './fixtures/ai-golden.json';
import companiesFixture from './fixtures/companies.json';
import errors from './fixtures/errors.json';
import examples from './fixtures/examples.json';
import notificationsFixture from './fixtures/notifications.json';
import previews from './fixtures/previews.json';
import quotes from './fixtures/quotes.json';
import scenarios from './fixtures/scenarios.json';
import statements from './fixtures/statements.json';
import { demoFetch } from './server';
import { timing } from './timing';

/** Снимки ответов — произвольный JSON. */
type J = any;

export interface SelfcheckIo {
    readFile(relativePath: string): Promise<Uint8Array>;
    log(line: string): void;
}

const PROCESSING = new Set(['SUBMITTED', 'IN_PROCESSING', 'ACCEPTED', 'SIGNED']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- сравнение

// Идентификаторы, номер ссудного счёта и год в номере заявки зависят от дня запуска, остальное — нет
const normalize = (text: string): string =>
    text
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
        .replace(/45207810\d{12}/g, '<счёт>')
        .replace(/\b\d{4}-(\d{5})\b/g, 'ГГГГ-$1');

class Check {
    failures: string[] = [];
    passed = 0;

    constructor(private io: SelfcheckIo) {}

    /** Сравнивает ожидаемое с фактическим: числа — с допуском на округление float, лишние поля не мешают. */
    same(label: string, expected: J, actual: J, ignore: string[] = []): void {
        const diffs: string[] = [];
        const walk = (e: J, a: J, path: string) => {
            if (ignore.some((p) => path === p || path.endsWith(`.${p}`))) return;
            if (typeof e === 'number' && (typeof a === 'number' || typeof a === 'string')) {
                const value = Number(a);
                if (Math.abs(e - value) > Math.max(1e-6, Math.abs(e) * 1e-9)) diffs.push(`${path}: ${e} ≠ ${a}`);
                return;
            }
            if (typeof e === 'string' && typeof a === 'string') {
                const numeric = /^-?\d+(\.\d+)?$/;
                const plain = normalize(e) === e && normalize(a) === a;
                if (plain && numeric.test(e) && numeric.test(a)) {
                    if (Math.abs(Number(e) - Number(a)) > 1e-6) diffs.push(`${path}: ${e} ≠ ${a}`);
                } else if (normalize(e) !== normalize(a)) diffs.push(`${path}: «${e}» ≠ «${a}»`);
                return;
            }
            if (Array.isArray(e)) {
                if (!Array.isArray(a)) return void diffs.push(`${path}: ожидали список, получили ${JSON.stringify(a)}`);
                if (e.length !== a.length) diffs.push(`${path}: ${e.length} элементов ≠ ${a.length}`);
                e.forEach((item, i) => walk(item, a[i], `${path}[${i}]`));
                return;
            }
            if (e && typeof e === 'object') {
                if (!a || typeof a !== 'object')
                    return void diffs.push(`${path}: ожидали объект, получили ${JSON.stringify(a)}`);
                for (const key of Object.keys(e)) walk(e[key], a[key], path ? `${path}.${key}` : key);
                return;
            }
            if (e !== a) diffs.push(`${path}: ${JSON.stringify(e)} ≠ ${JSON.stringify(a)}`);
        };
        walk(expected, actual, '');
        if (diffs.length) {
            this.failures.push(`${label}:\n    ${diffs.slice(0, 12).join('\n    ')}`);
            this.io.log(`✗ ${label} (${diffs.length})`);
        } else this.passed += 1;
    }

    /** Те же поля на всех уровнях, что в ответе настоящего API. */
    shape(label: string, expected: J, actual: J): void {
        const diffs: string[] = [];
        const walk = (e: J, a: J, path: string) => {
            if (e === null || a === null || typeof e !== 'object') return;
            if (Array.isArray(e)) {
                if (e.length && Array.isArray(a) && a.length) walk(e[0], a[0], `${path}[0]`);
                return;
            }
            if (typeof a !== 'object' || Array.isArray(a)) return void diffs.push(`${path}: не объект`);
            // ответы источников и признаки скоринга — произвольный JSON, сверяются отдельно
            if (/\.(result|features|details)$/.test(path)) return;
            const expectedKeys = Object.keys(e).sort().join(',');
            const actualKeys = Object.keys(a).sort().join(',');
            if (expectedKeys !== actualKeys) diffs.push(`${path || '.'}: {${expectedKeys}} ≠ {${actualKeys}}`);
            for (const key of Object.keys(e)) walk(e[key], a[key], `${path}.${key}`);
        };
        walk(expected, actual, '');
        if (diffs.length) {
            this.failures.push(`${label}:\n    ${diffs.slice(0, 8).join('\n    ')}`);
            this.io.log(`✗ ${label}`);
        } else this.passed += 1;
    }

    ok(label: string, condition: boolean, detail = ''): void {
        if (condition) this.passed += 1;
        else {
            this.failures.push(`${label}${detail ? `: ${detail}` : ''}`);
            this.io.log(`✗ ${label}`);
        }
    }
}

// ---------------------------------------------------------------- компактные снимки (как в скрипте съёмки)

const pick = (object: J, keys: string[]): J =>
    Object.fromEntries(keys.filter((k) => object && k in object).map((k) => [k, object[k]]));

function compactApp(app: Application): J {
    return {
        ...pick(app, [
            'number',
            'status',
            'status_label',
            'next_step',
            'needs_action',
            'can_cancel',
            'purpose',
            'purpose_label',
            'purpose_text',
            'amount',
            'term_months',
            'declared_revenue',
            'collateral_type',
            'collateral_value',
            'run_no',
            'explanation',
        ]),
        product: app.product.code,
        company: app.company.inn,
        steps: app.steps.map((s) => pick(s, ['step', 'title', 'status', 'attempts', 'waiting_text', 'error'])),
        offers: app.offers.map((o) =>
            pick(o, [
                'option_no',
                'kind',
                'product_code',
                'product_name',
                'product_kind',
                'amount',
                'term_months',
                'rate',
                'monthly_payment',
                'overpayment',
                'payment_label',
                'status',
                'note',
            ]),
        ),
        info_requests: app.info_requests.map((r) => pick(r, ['origin', 'items', 'comment', 'status', 'answer_text'])),
        documents: app.documents.map((d) =>
            pick(d, [
                'kind',
                'kind_label',
                'source',
                'file_name',
                'content_type',
                'size',
                'parsed',
                'signed_by_client',
                'signed_by_bank',
            ]),
        ),
        history: app.history.map((h) =>
            pick(h, ['from_status', 'to_status', 'to_label', 'actor', 'actor_name', 'reason']),
        ),
        loan: app.loan && {
            ...pick(app.loan, ['product_code', 'account_number', 'amount', 'rate', 'term_months', 'monthly_payment']),
            schedule_length: app.loan.schedule.length,
            schedule: [app.loan.schedule[0], app.loan.schedule.at(-1)].map((r) =>
                pick(r, ['n', 'payment', 'principal', 'interest', 'balance']),
            ),
            total_principal: app.loan.schedule.reduce((sum, r) => sum + Number(r.principal), 0).toFixed(2),
            total_interest: app.loan.schedule.reduce((sum, r) => sum + Number(r.interest), 0).toFixed(2),
        },
    };
}

const EXTERNAL = ['EGRUL', 'FNS', 'GIRBO', 'BKI', 'BANK'];
// Стартовые заявки обрабатываются параллельно, поэтому порядок в очереди (по сроку рассмотрения) может отличаться
const byNumber = (a: J, b: J) => a.number.localeCompare(b.number);
// Строка очереди после сброса: приоритет с причинами и исполнитель — стартовые заявки распределены по порядку номеров
const QUEUE_RESET_FIELDS = [
    'number',
    'company_name',
    'status',
    'risk_class',
    'score',
    'flags',
    'priority',
    'priority_reasons',
    'assignee_name',
];
// Поля строки очереди, которые сохраняет скрипт съёмки (QUEUE_ROW_FIELDS)
const QUEUE_ROW_FIELDS = ['status', 'flags', 'priority', 'priority_reasons', 'assignee_name', 'assignee_is_me'];

/** Ручное рассмотрение сверху, внутри — по приоритету, затем по сроку рассмотрения (как сортирует сервер). */
function queueOrdered(rows: J[]): boolean {
    const status = (row: J) => ({ MANUAL_REVIEW: 0, IN_PROCESSING: 1, NEED_INFO: 2 })[row.status as string] ?? 3;
    const rank = (row: J) => (row.priority ? PRIORITY_RANK[row.priority as keyof typeof PRIORITY_RANK] : 3);
    const key = (row: J) => [status(row), rank(row), row.sla_due_at ?? row.status_changed_at] as const;
    return rows.every((row, i) => {
        if (i === 0) return true;
        const [a, b] = [key(rows[i - 1]), key(row)];
        return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] <= b[2])));
    });
}
// Показатели: сроки и календарь зависят от момента снятия снимка и скорости стенда, сверяются только счётчики
const METRICS_TIMING_KEYS = [
    'since',
    'until',
    'daily',
    'to_decision_median_seconds',
    'to_decision_p95_seconds',
    'to_issue_median_hours',
    'info_response_median_hours',
    'review_median_hours',
    'median_review_hours',
];
// Профиль компании из конструктора без полей, которые зависят от стенда и дня запуска (ИНН, ОГРН, даты, id)
const COMPANY_STABLE_FIELDS = [
    'name',
    'legal_form',
    'okved',
    'okved_name',
    'address',
    'status',
    'status_label',
    'director_name',
    'is_bank_client',
    'business_months',
    'account_months',
];
const decisionView = (d: J) =>
    d &&
    pick(d, [
        'kind',
        'outcome',
        'policy_version',
        'limit',
        'limit_binding',
        'rate',
        'flags',
        'stop_factors',
        'reason_codes',
        'trace',
        'comment',
        'decided_by',
    ]);

function compactDossier(dossier: Dossier): J {
    return {
        sources: Object.fromEntries(
            Object.entries(dossier.sources).map(([code, s]) => [
                code,
                EXTERNAL.includes(code)
                    ? pick(s, ['status', 'error', 'attempts'])
                    : pick(s, ['status', 'result', 'error', 'attempts']),
            ]),
        ),
        scoring: dossier.scoring,
        auto_decision: decisionView(dossier.auto_decision),
        last_decision: decisionView(dossier.last_decision),
        limit: dossier.limit,
        assignee: dossier.assignee,
        audit: dossier.audit.map((a) => pick(a, ['action', 'actor', 'user', 'details'])),
    };
}

const compactNotifications = (data: J) => ({
    unread: data.unread,
    items: data.items.map((n: J) => pick(n, ['kind', 'title', 'body', 'unread'])),
});

// ---------------------------------------------------------------- клиент API поверх demoFetch

class ApiError extends Error {
    constructor(
        public status: number,
        public detail: J,
    ) {
        super(`${status}: ${JSON.stringify(detail)}`);
    }
}

async function call(
    method: string,
    path: string,
    token: string | null,
    body?: J,
    headers: Record<string, string> = {},
): Promise<J> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (token) (init.headers as Record<string, string>).Authorization = `Bearer ${token}`;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const response = await demoFetch(path, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ApiError(response.status, data?.detail ?? null);
    return data;
}

interface Session {
    token: string;
    user: J;
    get(path: string): Promise<J>;
    post(path: string, body?: J, headers?: Record<string, string>): Promise<J>;
    put(path: string, body?: J): Promise<J>;
    patch(path: string, body?: J): Promise<J>;
    del(path: string): Promise<J>;
    error(
        method: string,
        path: string,
        body?: J,
        headers?: Record<string, string>,
    ): Promise<{ status: number; detail: J }>;
}

async function session(login: string): Promise<Session> {
    const data = await call('POST', '/api/auth/login', null, { login, password: DEMO_PASSWORD });
    const token = data.token as string;
    return {
        token,
        user: data.user,
        get: (path) => call('GET', path, token),
        post: (path, body, headers) => call('POST', path, token, body, headers),
        put: (path, body) => call('PUT', path, token, body),
        patch: (path, body) => call('PATCH', path, token, body),
        del: (path) => call('DELETE', path, token),
        error: async (method, path, body, headers) => {
            try {
                await call(method, path, token, body, headers);
            } catch (error) {
                if (error instanceof ApiError) return { status: error.status, detail: error.detail };
                throw error;
            }
            throw new Error(`${method} ${path}: ожидали ошибку`);
        },
    };
}

async function waitFor<T>(check: () => Promise<T | null>, what: string, timeout = 20_000): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Не дождались: ${what}`);
        await sleep(20);
    }
}

const settle = (s: Session, id: string, until?: string[]): Promise<J> =>
    waitFor(
        async () => {
            const app = await s.get(`/api/applications/${id}`);
            return (until ? until.includes(app.status) : !PROCESSING.has(app.status)) ? app : null;
        },
        `заявка ${id} → ${until ?? 'итоговый статус'}`,
    );

const key = () => crypto.randomUUID();

async function apply(s: Session, body: J): Promise<J> {
    const draft = await s.post('/api/applications', { purpose_text: 'Тестовая заявка', ...body });
    await s.post(
        `/api/applications/${draft.id}/submit`,
        { consent_bki: true, consent_pd: true },
        { 'Idempotency-Key': key() },
    );
    return settle(s, draft.id);
}

// ---------------------------------------------------------------- проверки

function checkEngine(check: Check): void {
    for (const item of aiGolden as J[]) {
        check.same(`разбор потребности №${item.id}: «${item.text}»`, item.result, parseNeedRules(item.text));
    }
    checkPriorityRules(check);
}

/**
 * Правила приоритета, которые снимком стенда не проверить: срок рассмотрения на стенде — сутки, а флаг F05
 * появляется после 15 минут ожидания источника. Ожидаемое — как в юнит-тестах сервера
 * (backend/tests/unit/test_review.py).
 */
function checkPriorityRules(check: Check): void {
    const now = Date.parse('2026-10-24T12:00:00Z');
    const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
    const cases: [string, Parameters<typeof reviewPriority>[1], J][] = [
        [
            'срок истёк',
            { now, sla_due_at: at(-0.02), amount: 3_000_000, flags: [] },
            { priority: 'HIGH', reasons: ['Срок рассмотрения истёк'] },
        ],
        [
            'до срока меньше 4 часов, крупная сумма и флаги',
            { now, sla_due_at: at(1), amount: 12_000_000, flags: ['F01', 'F02'] },
            {
                priority: 'HIGH',
                reasons: [
                    'До конца срока меньше 4 часов',
                    'Сумма от 10\u00a0млн\u00a0₽',
                    'Флаги F01, F02 требуют проверки',
                ],
            },
        ],
        [
            'ровно 4 часа до срока',
            { now, sla_due_at: at(4), amount: 3_000_000, flags: [] },
            { priority: 'NORMAL', reasons: [] },
        ],
        [
            'один флаг',
            { now, sla_due_at: at(20), amount: 3_000_000, flags: ['F06'] },
            { priority: 'MEDIUM', reasons: ['Флаг F06 требует проверки'] },
        ],
        [
            'только класс риска C или D',
            { now, sla_due_at: at(20), amount: 3_000_000, flags: ['F07'] },
            { priority: 'NORMAL', reasons: [] },
        ],
        [
            'ждём источник при истёкшем сроке',
            { now, sla_due_at: at(-2), amount: 60_000_000, flags: ['F01', 'F05'] },
            { priority: 'NORMAL', reasons: ['Ждём ответа источника'] },
        ],
    ];
    for (const [label, input, expected] of cases) {
        check.same(`приоритет: ${label}`, expected, reviewPriority('MANUAL_REVIEW', input));
    }
    check.same(
        'приоритет: не на ручном рассмотрении',
        { priority: null, reasons: [] },
        reviewPriority('OFFER', cases[0][1]),
    );
}

async function checkStatements(check: Check, io: SelfcheckIo): Promise<void> {
    for (const [name, expected] of Object.entries(statements as J)) {
        const parsed = parseStatement(name, await io.readFile(`public/demo-files/${name}`));
        check.same(`разбор выписки ${name}`, expected, parsed);
    }
}

async function checkQuotes(check: Check): Promise<void> {
    for (const item of quotes as J[]) {
        const response = await call('POST', '/api/calculator/quote', null, item.request);
        const compact = response.map(({ product, ...rest }: J) => ({ code: product.code, ...rest }));
        check.same(`подбор ${item.login} ${item.request.purpose}`, item.response, compact);
    }
    check.shape(
        'подбор: поля ответа',
        examples.quote,
        await call('POST', '/api/calculator/quote', null, (quotes as J[])[0].request),
    );
}

export async function run(io: SelfcheckIo): Promise<boolean> {
    timing.scale = 0.05;
    const check = new Check(io);
    const S = scenarios as J;
    const E = errors as J;
    const errorsSeen: Record<string, { status: number; detail: J }> = {};

    checkEngine(check);
    await checkStatements(check, io);

    const sessions: Record<string, Session> = {};
    for (const login of [
        'veter',
        'smirnova',
        'tehnomaster',
        'orlov',
        'vektor',
        'grand',
        'start',
        'altair',
        'romashka',
        'meridian',
        'analyst',
        'analyst2',
        'admin',
    ]) {
        sessions[login] = await session(login);
    }
    const { analyst, analyst2, admin, veter, orlov, altair } = sessions;
    check.shape('пользователь: поля ответа', examples.me, await veter.get('/api/me'));
    await checkQuotes(check);
    for (const item of aiGolden as J[]) await veter.post('/api/ai/parse-need', { text: item.text });

    // Стартовые заявки vektor и grand
    const queue = await analyst.get('/api/bank/applications');
    check.same(
        'очередь после сброса',
        [...examples.queue].sort(byNumber).map((r: J) => pick(r, QUEUE_RESET_FIELDS)),
        [...queue].sort(byNumber).map((r: J) => pick(r, QUEUE_RESET_FIELDS)),
    );
    check.ok('очередь: по приоритету, затем по сроку рассмотрения', queueOrdered(queue));
    check.shape('очередь: поля ответа', examples.queue, queue);
    check.same('сводка после сброса', examples.summary, await analyst.get('/api/bank/summary'));
    for (const [login, expected] of Object.entries((examples as J).proactive as Record<string, J>)) {
        check.same(
            `предварительные предложения ${login}`,
            expected,
            await sessions[login].get('/api/offers/proactive'),
            ['computed_at'],
        );
    }
    check.same(
        'показатели после сброса',
        examples.metrics,
        await analyst.get('/api/bank/metrics?days=30'),
        METRICS_TIMING_KEYS,
    );
    const vektorId = queue.find((r: J) => r.company_name.includes('Вектор')).id;
    const grandId = queue.find((r: J) => r.company_name.includes('Гранд')).id;
    for (const [login, id] of [
        ['vektor', vektorId],
        ['grand', grandId],
    ] as const) {
        const dossier = await analyst.get(`/api/bank/applications/${id}/dossier`);
        check.same(
            `${login}: заявка у клиента`,
            S[`${login}-review`].application,
            compactApp(await sessions[login].get(`/api/applications/${id}`)),
        );
        check.same(`${login}: досье`, S[`${login}-review`].dossier, compactDossier(dossier));
        if (login === 'vektor') check.shape('досье: поля ответа', examples.dossier, dossier);
    }

    for (const item of previews as J[]) {
        const id = item.application === 'vektor' ? vektorId : item.application === 'grand' ? grandId : null;
        if (!id) continue;
        const preview = await analyst.post(`/api/bank/applications/${id}/terms-preview`, item.request);
        check.same(`расчёт условий ${item.application} ${JSON.stringify(item.request)}`, item.response, preview);
    }

    // С5. vektor
    await analyst.post(`/api/bank/applications/${vektorId}/assign`);
    await analyst.post(`/api/bank/applications/${vektorId}/info-requests`, {
        items: ['TAX_EXPLANATION'],
        comment: 'Поясните задолженность',
        due_hours: 48,
    });
    const vektorNeedInfo = await sessions.vektor.get(`/api/applications/${vektorId}`);
    const vektorRequest = vektorNeedInfo.info_requests.find((r: J) => r.status === 'OPEN');
    errorsSeen.answer_empty = await sessions.vektor.error('POST', `/api/info-requests/${vektorRequest.id}/answer`, {
        text: '  ',
    });
    await sessions.vektor.post(`/api/info-requests/${vektorRequest.id}/answer`, { text: 'Погасим до конца месяца' });
    const vektorBack = await sessions.vektor.get(`/api/applications/${vektorId}`);
    const vektorLimit = S['vektor-review'].dossier.limit.limit;
    const overLimit = Math.round((vektorLimit * 1.1) / 10_000) * 10_000;
    errorsSeen.decision_over_limit_no_comment = await analyst.error(
        'POST',
        `/api/bank/applications/${vektorId}/decision`,
        { action: 'COUNTER', amount: overLimit, term_months: 36 },
    );
    errorsSeen.decision_over_tolerance = await analyst.error('POST', `/api/bank/applications/${vektorId}/decision`, {
        action: 'COUNTER',
        amount: Math.round((vektorLimit * 1.3) / 10_000) * 10_000,
        term_months: 36,
        comment: 'Слишком много',
    });
    errorsSeen.reject_without_comment = await analyst.error('POST', `/api/bank/applications/${vektorId}/decision`, {
        action: 'REJECT',
        reason_code: 'R01',
    });
    errorsSeen.reject_without_reason = await analyst.error('POST', `/api/bank/applications/${vektorId}/decision`, {
        action: 'REJECT',
        comment: 'Без причины',
    });
    await analyst.post(`/api/bank/applications/${vektorId}/decision`, {
        action: 'COUNTER',
        amount: overLimit,
        term_months: 36,
        comment: 'Стабильные поступления на счёт, задолженность погашается',
    });
    check.same('vektor: запрос информации', S['vektor-counter'].need_info, compactApp(vektorNeedInfo));
    check.same('vektor: ответ клиента', S['vektor-counter'].answered, compactApp(vektorBack));
    check.same(
        'vektor: контрпредложение',
        S['vektor-counter'].application,
        compactApp(await sessions.vektor.get(`/api/applications/${vektorId}`)),
    );
    check.same(
        'vektor: досье после решения',
        S['vektor-counter'].dossier,
        compactDossier(await analyst.get(`/api/bank/applications/${vektorId}/dossier`)),
    );

    // С6. grand
    await analyst.post(`/api/bank/applications/${grandId}/assign`);
    await sessions.grand.post(`/api/applications/${grandId}/messages`, { text: 'Когда ждать решения?' });
    await analyst.post(`/api/applications/${grandId}/messages`, { text: 'Сегодня, документы в порядке' });
    await analyst.post(`/api/bank/applications/${grandId}/decision`, { action: 'APPROVE' });
    const grandMessages = await sessions.grand.get(`/api/applications/${grandId}/messages`);
    check.shape('чат: поля ответа', examples.messages, grandMessages);
    check.same(
        'grand: одобрение у клиента',
        S['grand-approve'].application,
        compactApp(await sessions.grand.get(`/api/applications/${grandId}`)),
    );
    check.same(
        'grand: одобрение у банка',
        S['grand-approve'].bank_view,
        compactApp(await analyst.get(`/api/applications/${grandId}`)),
    );
    check.same(
        'grand: досье',
        S['grand-approve'].dossier,
        compactDossier(await analyst.get(`/api/bank/applications/${grandId}/dossier`)),
    );
    check.same('grand: чат', S['grand-approve'].messages, {
        client: grandMessages.map((m: J) => pick(m, ['author_name', 'author_role', 'text'])),
        bank: (await analyst.get(`/api/applications/${grandId}/messages`)).map((m: J) =>
            pick(m, ['author_name', 'author_role', 'text']),
        ),
    });

    // С1. veter
    const need = 'Нужно 3 млн на закупку товара к сезону, верну за 2 года';
    const parsed = await veter.post('/api/ai/parse-need', { text: need });
    check.same('veter: разбор потребности', S['veter-issue'].parsed, parsed);
    const draft = await veter.post('/api/applications', {
        product_code: 'GROWTH',
        purpose: 'WORKING_CAPITAL',
        amount: 3_000_000,
        term_months: 24,
        purpose_text: 'Закупка товара к сезону',
        ai_parsed: { ...parsed, text: need },
    });
    check.shape('черновик: поля ответа', examples.draft, draft);
    errorsSeen.decline_draft = await veter.error('POST', `/api/applications/${draft.id}/decline`);
    errorsSeen.analyst_sees_draft = await analyst.error('GET', `/api/applications/${draft.id}`);
    errorsSeen.stranger_sees_application = await sessions.smirnova.error('GET', `/api/applications/${draft.id}`);
    const submitKey = key();
    const submitted = await veter.post(
        `/api/applications/${draft.id}/submit`,
        { consent_bki: true, consent_pd: true },
        { 'Idempotency-Key': submitKey },
    );
    check.shape('отправленная заявка: поля ответа', examples.submitted, submitted);
    const repeated = await veter.post(
        `/api/applications/${draft.id}/submit`,
        { consent_bki: true, consent_pd: true },
        { 'Idempotency-Key': submitKey },
    );
    check.ok('повтор отправки с тем же ключом', repeated.id === submitted.id);
    errorsSeen.submit_twice = await veter.error('POST', `/api/applications/${draft.id}/submit`, {
        consent_bki: true,
        consent_pd: true,
    });
    errorsSeen.patch_submitted = await veter.error('PATCH', `/api/applications/${draft.id}`, { amount: 100 });
    errorsSeen.delete_submitted = await veter.error('DELETE', `/api/applications/${draft.id}`);
    const veterOffer = await settle(veter, draft.id);
    check.shape('заявка с предложением: поля ответа', examples.application_offer, veterOffer);
    const veterDossier = await analyst.get(`/api/bank/applications/${draft.id}/dossier`);
    errorsSeen.decision_not_review = await analyst.error('POST', `/api/bank/applications/${draft.id}/decision`, {
        action: 'APPROVE',
    });
    errorsSeen.assign_not_review = await analyst.error('POST', `/api/bank/applications/${draft.id}/assign`);
    const veterPreview = (previews as J[]).find((p) => p.application === 'veter');
    check.same(
        'расчёт условий veter',
        veterPreview.response,
        await analyst.post(`/api/bank/applications/${draft.id}/terms-preview`, veterPreview.request),
    );
    await veter.post(`/api/offers/${veterOffer.offers[0].id}/accept`);
    const veterAccepted = await veter.get(`/api/applications/${draft.id}`);
    errorsSeen.accept_again = await veter.error('POST', `/api/offers/${veterOffer.offers[0].id}/accept`);
    const veterSigning = await settle(veter, draft.id, ['SIGNING']);
    const agreement = veterSigning.documents.find((d: J) => d.kind === 'AGREEMENT');
    const pdf = await demoFetch(`/api/documents/${agreement.id}/download`, {
        headers: { Authorization: `Bearer ${veter.token}` },
    });
    check.ok('договор скачивается', pdf.ok);
    errorsSeen.sign_wrong_password = await veter.error('POST', `/api/applications/${draft.id}/sign`, {
        password: 'wrong',
    });
    errorsSeen.analyst_signs = await analyst.error('POST', `/api/applications/${draft.id}/sign`, {
        password: DEMO_PASSWORD,
    });
    await veter.post(`/api/applications/${draft.id}/sign`, { password: DEMO_PASSWORD }, { 'Idempotency-Key': key() });
    const veterSigned = await veter.get(`/api/applications/${draft.id}`);
    const veterIssued = await settle(veter, draft.id, ['ISSUED']);
    check.shape('выданный кредит: поля ответа', examples.application_issued, veterIssued);
    check.shape('кредит и график: поля ответа', examples.loan, await veter.get(`/api/applications/${draft.id}/loan`));
    const V = S['veter-issue'];
    check.same('veter: предложение', V.offer, compactApp(veterOffer));
    check.same('veter: досье', V.dossier, compactDossier(veterDossier));
    check.same('veter: условия приняты', V.accepted, compactApp(veterAccepted));
    check.same('veter: подписание', V.signing, compactApp(veterSigning));
    check.same('veter: подписано', V.signed, compactApp(veterSigned));
    check.same('veter: кредит выдан', V.issued, compactApp(veterIssued));
    check.same(
        'veter: выдача у банка',
        V.issued_bank_view,
        compactApp(await analyst.get(`/api/applications/${draft.id}`)),
    );
    check.same(
        'veter: досье после выдачи',
        V.dossier_issued,
        compactDossier(await analyst.get(`/api/bank/applications/${draft.id}/dossier`)),
    );

    // С2. smirnova
    const smirnova = await apply(sessions.smirnova, {
        product_code: 'OVERDRAFT',
        purpose: 'CASH_GAP',
        amount: 1_000_000,
        term_months: 12,
    });
    const smirnovaDossier = await analyst.get(`/api/bank/applications/${smirnova.id}/dossier`);
    await sessions.smirnova.post(`/api/applications/${smirnova.id}/cancel`);
    check.same('smirnova: овердрафт', S['smirnova-overdraft'].application, compactApp(smirnova));
    check.same('smirnova: досье', S['smirnova-overdraft'].dossier, compactDossier(smirnovaDossier));
    check.same(
        'smirnova: отзыв',
        S['smirnova-overdraft'].cancelled,
        compactApp(await sessions.smirnova.get(`/api/applications/${smirnova.id}`)),
    );
    errorsSeen.cancel_cancelled = await sessions.smirnova.error('POST', `/api/applications/${smirnova.id}/cancel`);

    // С3. tehnomaster
    const tehno = await apply(sessions.tehnomaster, {
        product_code: 'GROWTH',
        purpose: 'WORKING_CAPITAL',
        amount: 6_000_000,
        term_months: 24,
    });
    const tehnoDossier = await analyst.get(`/api/bank/applications/${tehno.id}/dossier`);
    await sessions.tehnomaster.post(`/api/applications/${tehno.id}/decline`);
    check.same('tehnomaster: два варианта', S['tehnomaster-two-options'].application, compactApp(tehno));
    check.same('tehnomaster: досье', S['tehnomaster-two-options'].dossier, compactDossier(tehnoDossier));
    check.same(
        'tehnomaster: отказ клиента',
        S['tehnomaster-two-options'].declined,
        compactApp(await sessions.tehnomaster.get(`/api/applications/${tehno.id}`)),
    );
    const line = await apply(sessions.tehnomaster, {
        product_code: 'CREDIT_LINE',
        purpose: 'WORKING_CAPITAL',
        amount: 5_000_000,
        term_months: 18,
    });
    check.same('tehnomaster: кредитная линия', S['tehnomaster-credit-line'].application, compactApp(line));
    check.same(
        'tehnomaster: досье линии',
        S['tehnomaster-credit-line'].dossier,
        compactDossier(await analyst.get(`/api/bank/applications/${line.id}/dossier`)),
    );

    // С4. orlov
    const orlovApp = await apply(orlov, {
        product_code: 'EXPRESS',
        purpose: 'WORKING_CAPITAL',
        amount: 1_500_000,
        term_months: 24,
    });
    const orlovNeedDossier = await analyst.get(`/api/bank/applications/${orlovApp.id}/dossier`);
    const orlovRequest = orlovApp.info_requests.find((r: J) => r.status === 'OPEN');
    errorsSeen.answer_without_statement = await orlov.error('POST', `/api/info-requests/${orlovRequest.id}/answer`, {
        text: 'Выписку пришлю позже',
    });
    const form = (name: string, content: BlobPart, type: string, kind: string, requestId?: string) => {
        const data = new FormData();
        data.append('file', new File([content], name, { type }));
        data.append('kind', kind);
        if (requestId) data.append('info_request_id', requestId);
        return data;
    };
    errorsSeen.upload_bad_statement = await orlov.error(
        'POST',
        `/api/applications/${orlovApp.id}/documents`,
        form('notes.txt', 'not a statement', 'text/plain', 'BANK_STATEMENT'),
    );
    errorsSeen.upload_agreement_kind = await orlov.error(
        'POST',
        `/api/applications/${orlovApp.id}/documents`,
        form('x.txt', 'x', 'text/plain', 'AGREEMENT'),
    );
    errorsSeen.upload_bad_extension = await orlov.error(
        'POST',
        `/api/applications/${orlovApp.id}/documents`,
        form('tool.exe', 'MZ', 'application/octet-stream', 'OTHER'),
    );
    const statement1c = await io.readFile('public/demo-files/vypiska_orlov_1c.txt');
    const uploaded = await orlov.post(
        `/api/applications/${orlovApp.id}/documents`,
        form('vypiska_orlov_1c.txt', statement1c as BlobPart, 'text/plain', 'BANK_STATEMENT', orlovRequest.id),
    );
    check.shape('документ: поля ответа', examples.document, uploaded);
    await orlov.post(`/api/info-requests/${orlovRequest.id}/answer`, { text: 'Выписка за 12 месяцев' });
    const orlovRechecking = await orlov.get(`/api/applications/${orlovApp.id}`);
    const orlovOffer = await settle(orlov, orlovApp.id);
    const O = S['orlov-statement'];
    check.same('orlov: запрос выписки', O.need_info, compactApp(orlovApp));
    check.same('orlov: досье с запросом', O.need_info_dossier, compactDossier(orlovNeedDossier));
    check.same(
        'orlov: загруженная выписка',
        O.uploaded,
        pick(uploaded, ['kind', 'kind_label', 'source', 'file_name', 'content_type', 'size', 'sha256', 'parsed']),
    );
    check.same('orlov: повторная проверка', O.rechecking, compactApp(orlovRechecking), ['steps']);
    check.same('orlov: одобрено', O.application, compactApp(orlovOffer));
    check.same(
        'orlov: досье',
        O.dossier,
        compactDossier(await analyst.get(`/api/bank/applications/${orlovApp.id}/dossier`)),
    );
    const csvDraft = await orlov.post('/api/applications', {
        product_code: 'EXPRESS',
        purpose: 'WORKING_CAPITAL',
        amount: 1_000_000,
        term_months: 12,
    });
    const csvUploaded = await orlov.post(
        `/api/applications/${csvDraft.id}/documents`,
        form(
            'vypiska_orlov.csv',
            (await io.readFile('public/demo-files/vypiska_orlov.csv')) as BlobPart,
            'text/csv',
            'BANK_STATEMENT',
        ),
    );
    check.same('разбор CSV-выписки при загрузке', (statements as J)['vypiska_orlov.csv'], csvUploaded.parsed);
    await orlov.del(`/api/documents/${csvUploaded.id}`);
    // Выписка с кассовым разрывом — прогноз денежного потока
    const gapUploaded = await orlov.post(
        `/api/applications/${csvDraft.id}/documents`,
        form(
            'vypiska_smirnova.csv',
            (await io.readFile('public/demo-files/vypiska_smirnova.csv')) as BlobPart,
            'text/csv',
            'BANK_STATEMENT',
        ),
    );
    check.same('прогноз кассового разрыва по выписке', (statements as J)['vypiska_smirnova.csv'], gapUploaded.parsed);
    // Предварительный лимит по выписке без заявки — тот же файл, что в снимке examples.preliminary
    const preliminaryForm = new FormData();
    preliminaryForm.append(
        'file',
        new Blob([(await io.readFile('public/demo-files/vypiska_smirnova.csv')) as BlobPart], { type: 'text/csv' }),
        'vypiska_smirnova.csv',
    );
    const preliminary = await sessions.smirnova.post('/api/offers/preliminary', preliminaryForm);
    check.same('предварительный лимит по выписке без заявки', (examples as J).preliminary, preliminary, [
        'computed_at',
    ]);
    await orlov.del(`/api/documents/${gapUploaded.id}`);
    await orlov.del(`/api/applications/${csvDraft.id}`);
    errorsSeen.deleted_draft = await orlov.error('GET', `/api/applications/${csvDraft.id}`);

    // С7. start
    const startQuote = await call('POST', '/api/calculator/quote', null, {
        purpose: 'WORKING_CAPITAL',
        amount: 1_500_000,
        term_months: 24,
        business_months: 5,
        is_bank_client: true,
        account_months: 5,
    });
    check.same(
        'start: подбор',
        S['start-young'].quote,
        startQuote.map((q: J) => ({ code: q.product.code, eligible: q.eligible, issues: q.issues })),
    );
    const startApp = await apply(sessions.start, {
        product_code: 'STARTUP',
        purpose: 'WORKING_CAPITAL',
        amount: 1_500_000,
        term_months: 24,
    });
    const startDossier = await analyst2.get(`/api/bank/applications/${startApp.id}/dossier`);
    const startRow = (await analyst2.get('/api/bank/applications?status=MANUAL_REVIEW')).find(
        (r: J) => r.id === startApp.id,
    );
    errorsSeen.request_unknown_item = await analyst2.error(
        'POST',
        `/api/bank/applications/${startApp.id}/info-requests`,
        { items: ['UNKNOWN'], comment: '', due_hours: 24 },
    );
    await analyst2.post(`/api/bank/applications/${startApp.id}/decision`, {
        action: 'REJECT',
        reason_code: 'R01',
        comment: 'Недостаточная история бизнеса',
    });
    check.same('start: ручное рассмотрение', S['start-young'].review, compactApp(startApp));
    check.same('start: строка очереди', S['start-young'].queue_item, pick(startRow, QUEUE_ROW_FIELDS));
    check.same('start: досье', S['start-young'].dossier, compactDossier(startDossier));
    check.same(
        'start: отказ аналитика',
        S['start-young'].application,
        compactApp(await sessions.start.get(`/api/applications/${startApp.id}`)),
    );
    check.same(
        'start: досье после отказа',
        S['start-young'].dossier_rejected,
        compactDossier(await analyst2.get(`/api/bank/applications/${startApp.id}/dossier`)),
    );

    // С8. Стоп-факторы
    for (const login of ['romashka', 'meridian']) {
        const app = await apply(sessions[login], {
            product_code: 'GROWTH',
            purpose: 'WORKING_CAPITAL',
            amount: 2_000_000,
            term_months: 24,
        });
        check.same(`${login}: отказ`, S[`${login}-stop`].application, compactApp(app));
        check.same(
            `${login}: досье`,
            S[`${login}-stop`].dossier,
            compactDossier(await analyst.get(`/api/bank/applications/${app.id}/dossier`)),
        );
    }

    // С9. altair: обычная заявка, затем сбой БКИ
    const altairApp = await apply(altair, {
        product_code: 'EXPRESS',
        purpose: 'WORKING_CAPITAL',
        amount: 2_000_000,
        term_months: 12,
    });
    check.same('altair: одобрено', S['altair-approve'].application, compactApp(altairApp));
    check.same(
        'altair: досье',
        S['altair-approve'].dossier,
        compactDossier(await analyst.get(`/api/bank/applications/${altairApp.id}/dossier`)),
    );
    errorsSeen.analyst_sets_fault = await analyst.error('PUT', '/api/admin/simulator/faults/bki', { mode: 'error' });
    errorsSeen.unknown_fault_source = await admin.error('PUT', '/api/admin/simulator/faults/unknown', {
        mode: 'error',
    });
    const faultsError = await admin.put('/api/admin/simulator/faults/bki', { mode: 'error', latency_ms: 0 });
    check.same('сбой БКИ включён', examples.faults.bki_error, faultsError);
    const outage = await altair.post('/api/applications', {
        product_code: 'EXPRESS',
        purpose: 'WORKING_CAPITAL',
        amount: 2_000_000,
        term_months: 12,
    });
    await altair.post(`/api/applications/${outage.id}/submit`, { consent_bki: true, consent_pd: true });
    const waiting = await waitFor(async () => {
        const app = await altair.get(`/api/applications/${outage.id}`);
        return app.steps.find((s: J) => s.step === 'BKI')?.status === 'WAITING' ? app : null;
    }, 'ожидание БКИ');
    const A = S['altair-outage'];
    check.same('altair: ждём БКИ у клиента', A.waiting, compactApp(waiting), ['attempts']);
    check.shape('ожидание источника: поля ответа', examples.application_waiting, waiting);
    check.same(
        'altair: ждём БКИ у банка',
        A.waiting_bank_view,
        compactApp(await analyst.get(`/api/applications/${outage.id}`)),
        ['attempts', 'error'],
    );
    check.same(
        'altair: досье в ожидании',
        A.waiting_dossier,
        compactDossier(await analyst.get(`/api/bank/applications/${outage.id}/dossier`)),
        ['attempts', 'error'],
    );
    const issues = await analyst.get('/api/bank/pipeline/issues');
    check.same(
        'altair: список сбоев конвейера',
        A.waiting_issues,
        issues.map((i: J) =>
            pick(i, ['number', 'company_name', 'status', 'step', 'step_title', 'step_status', 'attempts', 'error']),
        ),
        ['attempts', 'error'],
    );
    check.shape('сбои конвейера: поля ответа', examples.pipeline_issues, issues);
    check.same('altair: сводка при сбое', A.waiting_summary, await analyst.get('/api/bank/summary'));
    const waitingRow = (await analyst.get('/api/bank/applications?status=SUBMITTED&status=IN_PROCESSING')).find(
        (r: J) => r.id === outage.id,
    );
    check.same(
        'altair: строка очереди',
        A.waiting_queue_item,
        pick(waitingRow, [
            'status',
            'status_label',
            'waiting_source',
            'risk_class',
            'score',
            'flags',
            'priority',
            'priority_reasons',
        ]),
    );
    check.ok(
        'altair: текст ошибки БКИ',
        /bki: сервис ответил ошибкой 503|приостановлены/.test(issues[0]?.error ?? ''),
        issues[0]?.error,
    );
    await admin.put('/api/admin/simulator/faults/bki', { mode: 'timeout', latency_ms: 0 });
    const timeoutStep = await waitFor(async () => {
        const dossier = await analyst.get(`/api/bank/applications/${outage.id}/dossier`);
        const error = dossier.sources.BKI.error ?? '';
        return error.includes('время') || error.includes('приостановлены') ? dossier.sources.BKI : null;
    }, 'ошибка таймаута БКИ');
    check.ok(
        'altair: текст таймаута',
        [
            A.timeout_step.error,
            'bki: превышено время ожидания ответа',
            'bki: вызовы приостановлены после серии ошибок',
        ].includes(timeoutStep.error),
        timeoutStep.error,
    );
    check.same('сбои сняты', examples.faults.reset, await admin.post('/api/admin/simulator/faults/reset'));
    await analyst.post(`/api/bank/applications/${outage.id}/pipeline/retry`);
    const recovered = await settle(altair, outage.id);
    check.same('altair: восстановление', A.application, compactApp(recovered), ['attempts']);
    check.same(
        'altair: досье после восстановления',
        A.dossier,
        compactDossier(await analyst.get(`/api/bank/applications/${outage.id}/dossier`)),
        ['attempts'],
    );

    // С15. Своя компания: администратор создаёт устойчивую компанию, под её логином подают заявку
    const C = S['custom-company'];
    check.same(
        'своя компания: справочник ОКВЭД',
        (examples as J).company_options,
        await admin.get('/api/admin/companies/options'),
    );
    errorsSeen.company_builder_analyst = await analyst.error('POST', '/api/admin/companies', C.spec);
    errorsSeen.company_builder_empty_name = await admin.error('POST', '/api/admin/companies', {
        ...C.spec,
        name: '   ',
    });
    errorsSeen.company_builder_overdue = await admin.error('POST', '/api/admin/companies', {
        ...C.spec,
        current_overdue_days: 40,
    });
    const created = await admin.post('/api/admin/companies', C.spec);
    check.shape('своя компания: поля ответа', (examples as J).company_created, created);
    // Логин на стенде мог получить номер, ИНН и даты зависят от стенда и дня запуска — сверяем остальное
    check.ok('своя компания: логин', created.login.replace(/\d+$/, '') === C.created.login_base, created.login);
    check.same('своя компания: профиль', C.created.company, pick(created.company, COMPANY_STABLE_FIELDS));
    // ИНН и ОГРН — из своей последовательности: у первой созданной компании ОГРН совпадал с «Северным ветром»
    const builtin = Object.values(companiesFixture.companies).map(({ company }) => company);
    check.ok(
        'своя компания: ИНН и ОГРН не совпадают со встроенными',
        builtin.every((company) => company.inn !== created.company.inn && company.ogrn !== created.company.ogrn),
        `${created.company.inn} / ${created.company.ogrn}`,
    );
    const custom = await session(created.login);
    check.same('своя компания: пользователь', C.user, pick(custom.user, ['full_name', 'position', 'role', 'can_sign']));
    const customApp = await apply(custom, C.request);
    check.same('своя компания: одобрение', C.application, compactApp(customApp), ['company']);
    check.same(
        'своя компания: досье',
        C.dossier,
        compactDossier(await analyst.get(`/api/bank/applications/${customApp.id}/dossier`)),
    );

    // Права доступа и ошибки
    errorsSeen.login_wrong_password = await (async () => {
        try {
            await call('POST', '/api/auth/login', null, { login: 'veter', password: 'wrong' });
        } catch (error) {
            if (error instanceof ApiError) return { status: error.status, detail: error.detail };
        }
        return { status: 200, detail: null };
    })();
    errorsSeen.me_without_token = await (async () => {
        try {
            await call('GET', '/api/me', null);
        } catch (error) {
            if (error instanceof ApiError) return { status: error.status, detail: error.detail };
        }
        return { status: 200, detail: null };
    })();
    errorsSeen.client_bank_summary = await veter.error('GET', '/api/bank/summary');
    errorsSeen.client_faults = await veter.error('GET', '/api/admin/simulator/faults');
    errorsSeen.analyst_client_list = await analyst.error('GET', '/api/applications');
    errorsSeen.analyst_company = await analyst.error('GET', '/api/company');
    errorsSeen.analyst_reset = await analyst.error('POST', '/api/admin/demo/reset');
    errorsSeen.unknown_path = await veter.error('GET', '/api/unknown');
    errorsSeen.wrong_method = await veter.error('DELETE', '/api/meta');
    errorsSeen.unknown_product = await veter.error('POST', '/api/applications', {
        product_code: 'NOPE',
        purpose: 'WORKING_CAPITAL',
        amount: 1_000_000,
        term_months: 12,
    });
    errorsSeen.negative_amount = await veter.error('POST', '/api/applications', {
        product_code: 'GROWTH',
        purpose: 'WORKING_CAPITAL',
        amount: -1,
        term_months: 12,
    });
    errorsSeen.parse_need_short = await veter.error('POST', '/api/ai/parse-need', { text: 'ab' });
    errorsSeen.ai_summary = await analyst.error('GET', `/api/bank/applications/${grandId}/ai-summary`);
    const ineligible = await sessions.start.post('/api/applications', {
        product_code: 'GROWTH',
        purpose: 'WORKING_CAPITAL',
        amount: 2_000_000,
        term_months: 24,
    });
    errorsSeen.submit_ineligible = await sessions.start.error('POST', `/api/applications/${ineligible.id}/submit`, {
        consent_bki: true,
        consent_pd: true,
    });
    errorsSeen.submit_without_consent = await sessions.start.error(
        'POST',
        `/api/applications/${ineligible.id}/submit`,
        { consent_bki: false, consent_pd: true },
    );
    await sessions.start.del(`/api/applications/${ineligible.id}`);
    const secured = await sessions.grand.post('/api/applications', {
        product_code: 'SECURED',
        purpose: 'EXPANSION',
        amount: 10_000_000,
        term_months: 60,
    });
    errorsSeen.submit_without_collateral = await sessions.grand.error(
        'POST',
        `/api/applications/${secured.id}/submit`,
        { consent_bki: true, consent_pd: true },
    );
    await sessions.grand.del(`/api/applications/${secured.id}`);
    for (const [name, expected] of Object.entries(E)) {
        if (name in errorsSeen) check.same(`ошибка ${name}`, expected, errorsSeen[name], ['input', 'ctx']);
        else check.ok(`ошибка ${name}`, false, 'сценарий не проверен');
    }

    // Уведомления: те же тексты у каждого пользователя (порядок между заявками зависит от времени)
    const sortItems = (data: J) => ({
        ...data,
        items: [...data.items].sort((a: J, b: J) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    });
    for (const [login, expected] of Object.entries(notificationsFixture as J)) {
        check.same(
            `уведомления ${login}`,
            sortItems(expected),
            sortItems(compactNotifications(await sessions[login].get('/api/notifications'))),
        );
    }
    check.shape('уведомления: поля ответа', examples.notifications, await veter.get('/api/notifications'));
    const auditRows = await admin.get('/api/admin/audit');
    check.shape('журнал: поля ответа', examples.audit, auditRows);
    check.same(
        'журнал: действия',
        examples.audit_actions,
        auditRows.slice(0, examples.audit_actions.length).map((r: J) => r.action),
    );
    const closed = await analyst.get('/api/bank/applications?include_closed=true');
    check.same(
        'очередь с завершёнными',
        [...examples.queue_closed].sort(byNumber),
        closed
            .map((r: J) =>
                pick(r, [
                    'number',
                    'status',
                    'status_label',
                    'risk_class',
                    'score',
                    'flags',
                    'priority',
                    'assignee_name',
                ]),
            )
            .sort(byNumber),
    );
    check.ok('очередь с завершёнными: порядок', queueOrdered(closed));
    check.same('сводка в конце', examples.summary_end, await analyst.get('/api/bank/summary'), ['issued_today']);
    const metricsEnd = await analyst.get('/api/bank/metrics?days=30');
    check.same('показатели в конце', examples.metrics_end, metricsEnd, METRICS_TIMING_KEYS);
    // Динамика по дням — по московской дате (как metrics.py): после 00:00 МСК в UTC ещё вчера
    check.ok(
        'показатели: день по Москве',
        moscowDate('2026-10-22T21:10:00Z') === '2026-10-23' &&
            moscowDate('2026-10-22T20:50:00Z') === '2026-10-22' &&
            metricsEnd.daily.at(-1)?.date === moscowDate(Date.now()) &&
            metricsEnd.daily.reduce((sum: number, d: J) => sum + d.submitted, 0) === metricsEnd.submitted,
        JSON.stringify(metricsEnd.daily.at(-1)),
    );

    // Сброс демо-данных возвращает стартовые заявки
    const reset = await admin.post('/api/admin/demo/reset');
    check.same('сброс демо-данных', { status: 'ok', preseeded: 2 }, reset);
    const afterReset = await waitFor(async () => {
        const rows = await analyst.get('/api/bank/applications');
        return rows.length === 2 && rows.every((r: J) => r.status === 'MANUAL_REVIEW') ? rows : null;
    }, 'стартовые заявки после сброса');
    check.same(
        'очередь после сброса администратором',
        [...examples.queue].sort(byNumber).map((r: J) => pick(r, QUEUE_RESET_FIELDS)),
        [...afterReset].sort(byNumber).map((r: J) => pick(r, QUEUE_RESET_FIELDS)),
    );

    io.log(`Проверок пройдено: ${check.passed}, с расхождениями: ${check.failures.length}`);
    for (const failure of check.failures) io.log(`\n✗ ${failure}`);
    return check.failures.length === 0;
}
