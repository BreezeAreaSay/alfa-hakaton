#!/usr/bin/env node
/**
 * Снимок ответов настоящего API для демо-режима интерфейса (frontend/src/demo).
 *
 * Нужен запущенный стенд (docker compose up -d --wait). Запуск из корня репозитория:
 *   node frontend/scripts/capture-demo-fixtures.mjs [--api http://localhost:8080]
 *
 * Скрипт сбрасывает демо-данные, проходит сценарии всех тестовых компаний (docs/test-scenarios.md)
 * и сохраняет ответы в frontend/src/demo/fixtures/: справочники, пользователей, профили компаний
 * и ответы внешних источников, а также снимки заявок и досье в ключевых состояниях — по ним
 * проверка demo-selfcheck сверяет имитацию с настоящим сервером. Договор из подписанной заявки
 * сохраняется в frontend/public/demo/agreement-sample.pdf. В конце демо-данные снова сбрасываются.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'frontend', 'src', 'demo', 'fixtures');
const AGREEMENT_PDF = join(ROOT, 'frontend', 'public', 'demo', 'agreement-sample.pdf');
const DEMO_FILES = join(ROOT, 'frontend', 'public', 'demo-files');
const GOLDEN_SET = join(ROOT, 'backend', 'app', 'ai_eval', 'golden_set.json');

const argIndex = process.argv.indexOf('--api');
const API = (argIndex > 0 ? process.argv[argIndex + 1] : process.env.API_URL) ?? 'http://localhost:8080';
const PASSWORD = 'admin';
const CLIENTS = [
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
];
const STAFF = ['analyst', 'analyst2', 'admin'];
const EXTERNAL = ['EGRUL', 'FNS', 'GIRBO', 'BKI', 'BANK'];
const PROCESSING = new Set(['SUBMITTED', 'IN_PROCESSING', 'ACCEPTED', 'SIGNED']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('·', ...args);

// ---------------------------------------------------------------- HTTP

async function call(method, path, { token, json, form, headers = {}, expect, raw = false } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (json !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
    }
    if (form) init.body = form;
    const response = await fetch(API + path, init);
    if (raw) return response;
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }
    const ok = expect === undefined ? response.ok : response.status === expect;
    if (!ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 500)}`);
    return { status: response.status, data };
}

async function session(login) {
    const { data } = await call('POST', '/api/auth/login', { json: { login, password: PASSWORD } });
    const token = data.token;
    return {
        login,
        token,
        user: data.user,
        get: async (path, options = {}) => (await call('GET', path, { token, ...options })).data,
        post: async (path, json, options = {}) => (await call('POST', path, { token, json, ...options })).data,
        put: async (path, json, options = {}) => (await call('PUT', path, { token, json, ...options })).data,
        patch: async (path, json, options = {}) => (await call('PATCH', path, { token, json, ...options })).data,
        del: async (path, options = {}) => (await call('DELETE', path, { token, ...options })).data,
        /** Ответ с ошибкой: код и текст, как их видит интерфейс. */
        error: async (method, path, json, options = {}) => {
            const response = await call(method, path, { token, json, ...options, raw: true });
            const body = await response.json().catch(() => null);
            if (response.ok) throw new Error(`${method} ${path}: ожидали ошибку, получили ${response.status}`);
            return { status: response.status, detail: body?.detail ?? null };
        },
    };
}

async function waitFor(check, what, timeout = 90_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Не дождались: ${what}`);
        await sleep(400);
    }
}

/** Ждём, пока заявка выйдет из автоматической обработки (или придёт в нужный статус). */
const settle = (s, id, until) =>
    waitFor(
        async () => {
            const app = await s.get(`/api/applications/${id}`);
            if (until ? until.includes(app.status) : !PROCESSING.has(app.status)) return app;
            return null;
        },
        `заявка ${id} → ${until ?? 'итоговый статус'}`,
    );

async function apply(s, body) {
    const draft = await s.post('/api/applications', { purpose_text: 'Тестовая заявка', ...body }, { expect: 201 });
    await s.post(
        `/api/applications/${draft.id}/submit`,
        { consent_bki: true, consent_pd: true },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
    );
    return settle(s, draft.id);
}

/** JSON с отступами, но короткие объекты и списки — в одну строку: файлы вдвое меньше и читаются легче. */
function formatJson(value, indent = '') {
    const inline = JSON.stringify(value);
    if (inline === undefined || inline.length + indent.length <= 110 || value === null || typeof value !== 'object') {
        return inline;
    }
    const inner = `${indent}  `;
    if (Array.isArray(value))
        return `[\n${value.map((item) => inner + formatJson(item, inner)).join(',\n')}\n${indent}]`;
    const entries = Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`);
    return `{\n${entries.join(',\n')}\n${indent}}`;
}

// ---------------------------------------------------------------- компактные снимки

const pick = (object, keys) => Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]]));

function compactApp(app) {
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
        steps: app.steps.map((s) => pick(s, ['step', 'status', 'attempts', 'waiting_text', 'error'])),
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

const decisionView = (d) =>
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

/** Досье; full = false — без признаков и факторов скоринга (они уже есть в предыдущем снимке заявки). */
function compactDossier(dossier, full = true) {
    return {
        sources: Object.fromEntries(
            Object.entries(dossier.sources).map(([code, s]) => [
                code,
                EXTERNAL.includes(code)
                    ? pick(s, ['status', 'error', 'attempts'])
                    : pick(s, ['status', 'result', 'error', 'attempts']),
            ]),
        ),
        scoring: full || !dossier.scoring ? dossier.scoring : pick(dossier.scoring, ['score', 'risk_class']),
        auto_decision: decisionView(dossier.auto_decision),
        last_decision: decisionView(dossier.last_decision),
        limit: dossier.limit,
        assignee: dossier.assignee,
        audit: dossier.audit.map((a) => pick(a, ['action', 'actor', 'user', 'details'])),
    };
}

/** Ответы внешних источников по заявке — входные данные компании для имитации конвейера. */
const sourcesOf = (dossier) =>
    Object.fromEntries(EXTERNAL.map((code) => [code, pick(dossier.sources[code], ['status', 'result'])]));

const compactNotifications = (data) => ({
    unread: data.unread,
    items: data.items.map((n) => pick(n, ['kind', 'title', 'body', 'unread'])),
});

// ---------------------------------------------------------------- сценарии

async function main() {
    log(`API: ${API}`);
    const health = await call('GET', '/api/health');
    if (health.data?.status !== 'ok') throw new Error('Стенд не отвечает');

    const admin = await session('admin');
    await admin.post('/api/admin/demo/reset');
    const sessions = {};
    for (const login of [...CLIENTS, ...STAFF]) sessions[login] = await session(login);
    const { analyst, analyst2 } = sessions;
    const capturedAt = new Date().toISOString();

    const scenarios = {};
    const examples = {};
    const errors = {};
    const companySources = {};

    // Справочники и пользователи
    const meta = (await call('GET', '/api/meta')).data;
    const products = (await call('GET', '/api/products')).data;
    const users = [...CLIENTS, ...STAFF].map((login) => {
        const { company, ...user } = sessions[login].user;
        return { ...user, company_id: company?.id ?? null };
    });
    examples.me = await sessions.veter.get('/api/me');
    const companies = {};
    for (const login of CLIENTS) companies[login] = await sessions[login].get('/api/company');
    examples.proactive = {};
    for (const login of CLIENTS) examples.proactive[login] = await sessions[login].get('/api/offers/proactive');
    const faultsInitial = await admin.get('/api/admin/simulator/faults');
    const aiStatus = await sessions.veter.get('/api/ai/status');

    // Разбор потребности на правилах по эталонному набору
    const golden = JSON.parse(await readFile(GOLDEN_SET, 'utf8'));
    const aiGolden = [];
    for (const item of golden) {
        const result = await sessions.veter.post('/api/ai/parse-need', { text: item.text });
        aiGolden.push({ id: item.id, text: item.text, result });
    }
    log(`разбор потребности: ${aiGolden.length} фраз`);

    // Подбор продуктов: параметры компании каждого клиента, все цели
    const quotes = [];
    for (const login of CLIENTS) {
        const company = companies[login];
        for (const [purpose, amount, term] of [
            ['WORKING_CAPITAL', 3_000_000, 24],
            ['CASH_GAP', 1_000_000, 12],
            ['EQUIPMENT', 8_000_000, 48],
            ['EXPANSION', 40_000_000, 84],
        ]) {
            const body = {
                purpose,
                amount,
                term_months: term,
                legal_form: company.legal_form,
                business_months: company.business_months,
                is_bank_client: company.is_bank_client,
                account_months: company.account_months ?? 0,
            };
            const response = (await call('POST', '/api/calculator/quote', { json: body })).data;
            examples.quote ??= response;
            quotes.push({
                login,
                request: body,
                response: response.map(({ product, ...item }) => ({ code: product.code, ...item })),
            });
        }
    }

    // Заявки, созданные сбросом: vektor и grand уходят к аналитику
    const queue = await waitFor(async () => {
        const rows = await analyst.get('/api/bank/applications');
        return rows.length === 2 && rows.every((r) => r.status === 'MANUAL_REVIEW') ? rows : null;
    }, 'стартовые заявки в очереди');
    examples.queue = queue;
    examples.summary = await analyst.get('/api/bank/summary');
    examples.metrics = await analyst.get('/api/bank/metrics?days=30');
    const vektorId = queue.find((r) => r.inn === companies.vektor.inn).id;
    const grandId = queue.find((r) => r.inn === companies.grand.inn).id;
    for (const [login, id] of [
        ['vektor', vektorId],
        ['grand', grandId],
    ]) {
        const dossier = await analyst.get(`/api/bank/applications/${id}/dossier`);
        const app = await sessions[login].get(`/api/applications/${id}`);
        scenarios[`${login}-review`] = {
            login,
            request: pick(app, [
                'purpose',
                'purpose_text',
                'amount',
                'term_months',
                'declared_revenue',
                'collateral_type',
                'collateral_value',
            ]),
            product: app.product.code,
            application: compactApp(app),
            dossier: compactDossier(dossier),
        };
        companySources[login] = sourcesOf(dossier);
        if (login === 'vektor') examples.dossier = dossier;
    }

    // Предварительный расчёт условий у аналитика
    const previews = [];
    const vektorLimit = scenarios['vektor-review'].dossier.limit.limit;
    for (const [id, body] of [
        [vektorId, { product_code: 'GROWTH', amount: 12_000_000, term_months: 36 }],
        [vektorId, { product_code: 'GROWTH', amount: vektorLimit, term_months: 36 }],
        [
            vektorId,
            { product_code: 'GROWTH', amount: Math.round((vektorLimit * 1.1) / 10_000) * 10_000, term_months: 36 },
        ],
        [
            vektorId,
            { product_code: 'GROWTH', amount: Math.round((vektorLimit * 1.3) / 10_000) * 10_000, term_months: 36 },
        ],
        [vektorId, { product_code: 'GROWTH', amount: 5_000_000, term_months: 60, rate: 19 }],
        [vektorId, { product_code: 'GROWTH', amount: 5_000_000, term_months: 48, rate: 24.5 }],
        [vektorId, { product_code: 'EXPRESS', amount: 3_000_000, term_months: 24 }],
        [vektorId, { product_code: 'CREDIT_LINE', amount: 4_000_000, term_months: 18 }],
        [vektorId, { product_code: 'OVERDRAFT', amount: 1_000_000, term_months: 12 }],
        [vektorId, { product_code: 'STARTUP', amount: 1_000_000, term_months: 12 }],
        [vektorId, { product_code: 'SECURED', amount: 10_000_000, term_months: 60 }],
        [grandId, { product_code: 'SECURED', amount: 60_000_000, term_months: 84 }],
        [grandId, { product_code: 'SECURED', amount: 100_000_000, term_months: 120 }],
        [grandId, { product_code: 'GROWTH', amount: 20_000_000, term_months: 60 }],
    ]) {
        previews.push({
            application: id === vektorId ? 'vektor' : 'grand',
            request: body,
            response: await analyst.post(`/api/bank/applications/${id}/terms-preview`, body),
        });
    }

    // С5. vektor: запрос информации, ответ клиента, контрпредложение выше лимита
    await analyst.post(`/api/bank/applications/${vektorId}/assign`);
    await analyst.post(`/api/bank/applications/${vektorId}/info-requests`, {
        items: ['TAX_EXPLANATION'],
        comment: 'Поясните задолженность',
        due_hours: 48,
    });
    const vektorNeedInfo = await sessions.vektor.get(`/api/applications/${vektorId}`);
    const vektorRequest = vektorNeedInfo.info_requests.find((r) => r.status === 'OPEN');
    errors.answer_empty = await sessions.vektor.error('POST', `/api/info-requests/${vektorRequest.id}/answer`, {
        text: '  ',
    });
    await sessions.vektor.post(`/api/info-requests/${vektorRequest.id}/answer`, { text: 'Погасим до конца месяца' });
    const vektorBack = await sessions.vektor.get(`/api/applications/${vektorId}`);
    const overLimit = Math.round((vektorLimit * 1.1) / 10_000) * 10_000;
    errors.decision_over_limit_no_comment = await analyst.error('POST', `/api/bank/applications/${vektorId}/decision`, {
        action: 'COUNTER',
        amount: overLimit,
        term_months: 36,
    });
    errors.decision_over_tolerance = await analyst.error('POST', `/api/bank/applications/${vektorId}/decision`, {
        action: 'COUNTER',
        amount: Math.round((vektorLimit * 1.3) / 10_000) * 10_000,
        term_months: 36,
        comment: 'Слишком много',
    });
    errors.reject_without_comment = await analyst.error('POST', `/api/bank/applications/${vektorId}/decision`, {
        action: 'REJECT',
        reason_code: 'R01',
    });
    errors.reject_without_reason = await analyst.error('POST', `/api/bank/applications/${vektorId}/decision`, {
        action: 'REJECT',
        comment: 'Без причины',
    });
    await analyst.post(`/api/bank/applications/${vektorId}/decision`, {
        action: 'COUNTER',
        amount: overLimit,
        term_months: 36,
        comment: 'Стабильные поступления на счёт, задолженность погашается',
    });
    scenarios['vektor-counter'] = {
        login: 'vektor',
        need_info: compactApp(vektorNeedInfo),
        answered: compactApp(vektorBack),
        application: compactApp(await sessions.vektor.get(`/api/applications/${vektorId}`)),
        dossier: compactDossier(await analyst.get(`/api/bank/applications/${vektorId}/dossier`), false),
    };
    log('vektor: запрос информации и контрпредложение');

    // С6. grand: аналитик одобряет, клиент и аналитик переписываются в чате
    await analyst.post(`/api/bank/applications/${grandId}/assign`);
    await sessions.grand.post(
        `/api/applications/${grandId}/messages`,
        { text: 'Когда ждать решения?' },
        { expect: 201 },
    );
    await analyst.post(
        `/api/applications/${grandId}/messages`,
        { text: 'Сегодня, документы в порядке' },
        { expect: 201 },
    );
    await analyst.post(`/api/bank/applications/${grandId}/decision`, { action: 'APPROVE' });
    examples.messages = await sessions.grand.get(`/api/applications/${grandId}/messages`);
    scenarios['grand-approve'] = {
        login: 'grand',
        application: compactApp(await sessions.grand.get(`/api/applications/${grandId}`)),
        bank_view: compactApp(await analyst.get(`/api/applications/${grandId}`)),
        dossier: compactDossier(await analyst.get(`/api/bank/applications/${grandId}/dossier`), false),
        messages: {
            client: examples.messages.map((m) => pick(m, ['author_name', 'author_role', 'text'])),
            bank: (await analyst.get(`/api/applications/${grandId}/messages`)).map((m) =>
                pick(m, ['author_name', 'author_role', 'text']),
            ),
        },
    };
    log('grand: одобрено аналитиком');

    // С1. veter: автоодобрение, подписание, выдача
    const veter = sessions.veter;
    const parsed = await veter.post('/api/ai/parse-need', {
        text: 'Нужно 3 млн на закупку товара к сезону, верну за 2 года',
    });
    const veterDraft = await veter.post(
        '/api/applications',
        {
            product_code: 'GROWTH',
            purpose: 'WORKING_CAPITAL',
            amount: 3_000_000,
            term_months: 24,
            purpose_text: 'Закупка товара к сезону',
            ai_parsed: { ...parsed, text: 'Нужно 3 млн на закупку товара к сезону, верну за 2 года' },
        },
        { expect: 201 },
    );
    examples.draft = veterDraft;
    errors.decline_draft = await veter.error('POST', `/api/applications/${veterDraft.id}/decline`);
    errors.analyst_sees_draft = await analyst.error('GET', `/api/applications/${veterDraft.id}`);
    errors.stranger_sees_application = await sessions.smirnova.error('GET', `/api/applications/${veterDraft.id}`);
    const submitKey = crypto.randomUUID();
    const submitted = await veter.post(
        `/api/applications/${veterDraft.id}/submit`,
        { consent_bki: true, consent_pd: true },
        { headers: { 'Idempotency-Key': submitKey } },
    );
    examples.submitted = submitted;
    const repeated = await veter.post(
        `/api/applications/${veterDraft.id}/submit`,
        { consent_bki: true, consent_pd: true },
        { headers: { 'Idempotency-Key': submitKey } },
    );
    if (repeated.id !== submitted.id) throw new Error('Повтор отправки вернул другую заявку');
    errors.submit_twice = await veter.error('POST', `/api/applications/${veterDraft.id}/submit`, {
        consent_bki: true,
        consent_pd: true,
    });
    errors.patch_submitted = await veter.error('PATCH', `/api/applications/${veterDraft.id}`, { amount: 100 });
    errors.delete_submitted = await veter.error('DELETE', `/api/applications/${veterDraft.id}`);
    const veterOffer = await settle(veter, veterDraft.id);
    examples.application_offer = veterOffer;
    const veterOfferDossier = await analyst.get(`/api/bank/applications/${veterDraft.id}/dossier`);
    companySources.veter = sourcesOf(veterOfferDossier);
    errors.decision_not_review = await analyst.error('POST', `/api/bank/applications/${veterDraft.id}/decision`, {
        action: 'APPROVE',
    });
    errors.assign_not_review = await analyst.error('POST', `/api/bank/applications/${veterDraft.id}/assign`);
    previews.push({
        application: 'veter',
        request: { product_code: 'GROWTH', amount: 3_000_000, term_months: 24 },
        response: await analyst.post(`/api/bank/applications/${veterDraft.id}/terms-preview`, {
            product_code: 'GROWTH',
            amount: 3_000_000,
            term_months: 24,
        }),
    });
    await veter.post(`/api/offers/${veterOffer.offers[0].id}/accept`);
    const veterAccepted = await veter.get(`/api/applications/${veterDraft.id}`);
    errors.accept_again = await veter.error('POST', `/api/offers/${veterOffer.offers[0].id}/accept`);
    const veterSigning = await settle(veter, veterDraft.id, ['SIGNING']);
    const agreement = veterSigning.documents.find((d) => d.kind === 'AGREEMENT');
    const pdfResponse = await call('GET', `/api/documents/${agreement.id}/download`, { token: veter.token, raw: true });
    const pdf = Buffer.from(await pdfResponse.arrayBuffer());
    if (!pdf.subarray(0, 4).equals(Buffer.from('%PDF'))) throw new Error('Договор — не PDF');
    await mkdir(dirname(AGREEMENT_PDF), { recursive: true });
    await writeFile(AGREEMENT_PDF, pdf);
    const agreementInfo = {
        source_application: veterSigning.number,
        file_name: agreement.file_name,
        content_type: agreement.content_type,
        size: pdf.length,
        sha256: createHash('sha256').update(pdf).digest('hex'),
        content_disposition: pdfResponse.headers.get('content-disposition'),
    };
    errors.sign_wrong_password = await veter.error('POST', `/api/applications/${veterDraft.id}/sign`, {
        password: 'wrong',
    });
    errors.analyst_signs = await analyst.error('POST', `/api/applications/${veterDraft.id}/sign`, {
        password: PASSWORD,
    });
    await veter.post(
        `/api/applications/${veterDraft.id}/sign`,
        { password: PASSWORD },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
    );
    const veterSigned = await veter.get(`/api/applications/${veterDraft.id}`);
    const veterIssued = await settle(veter, veterDraft.id, ['ISSUED']);
    // для сверки полей достаточно начала графика
    const loan = await veter.get(`/api/applications/${veterDraft.id}/loan`);
    examples.application_issued = {
        ...veterIssued,
        loan: { ...veterIssued.loan, schedule: veterIssued.loan.schedule.slice(0, 2) },
    };
    examples.loan = { ...loan, schedule: loan.schedule.slice(0, 2) };
    scenarios['veter-issue'] = {
        login: 'veter',
        request: { product_code: 'GROWTH', purpose: 'WORKING_CAPITAL', amount: 3_000_000, term_months: 24 },
        parsed,
        offer: compactApp(veterOffer),
        dossier: compactDossier(veterOfferDossier),
        accepted: compactApp(veterAccepted),
        signing: compactApp(veterSigning),
        signed: compactApp(veterSigned),
        issued: compactApp(veterIssued),
        issued_bank_view: compactApp(await analyst.get(`/api/applications/${veterDraft.id}`)),
        dossier_issued: compactDossier(await analyst.get(`/api/bank/applications/${veterDraft.id}/dossier`), false),
    };
    log('veter: выдан кредит, договор сохранён');

    // С2. smirnova: овердрафт, контрпредложение по оборотам; затем отзыв заявки
    const smirnovaApp = await apply(sessions.smirnova, {
        product_code: 'OVERDRAFT',
        purpose: 'CASH_GAP',
        amount: 1_000_000,
        term_months: 12,
    });
    const smirnovaDossier = await analyst.get(`/api/bank/applications/${smirnovaApp.id}/dossier`);
    companySources.smirnova = sourcesOf(smirnovaDossier);
    await sessions.smirnova.post(`/api/applications/${smirnovaApp.id}/cancel`);
    scenarios['smirnova-overdraft'] = {
        login: 'smirnova',
        request: { product_code: 'OVERDRAFT', purpose: 'CASH_GAP', amount: 1_000_000, term_months: 12 },
        application: compactApp(smirnovaApp),
        dossier: compactDossier(smirnovaDossier),
        cancelled: compactApp(await sessions.smirnova.get(`/api/applications/${smirnovaApp.id}`)),
    };
    errors.cancel_cancelled = await sessions.smirnova.error('POST', `/api/applications/${smirnovaApp.id}/cancel`);
    log('smirnova: контрпредложение и отзыв');

    // С3. tehnomaster: два варианта; затем отказ клиента от второй заявки
    const tehnoApp = await apply(sessions.tehnomaster, {
        product_code: 'GROWTH',
        purpose: 'WORKING_CAPITAL',
        amount: 6_000_000,
        term_months: 24,
    });
    const tehnoDossier = await analyst.get(`/api/bank/applications/${tehnoApp.id}/dossier`);
    companySources.tehnomaster = sourcesOf(tehnoDossier);
    await sessions.tehnomaster.post(`/api/applications/${tehnoApp.id}/decline`);
    scenarios['tehnomaster-two-options'] = {
        login: 'tehnomaster',
        request: { product_code: 'GROWTH', purpose: 'WORKING_CAPITAL', amount: 6_000_000, term_months: 24 },
        application: compactApp(tehnoApp),
        dossier: compactDossier(tehnoDossier),
        declined: compactApp(await sessions.tehnomaster.get(`/api/applications/${tehnoApp.id}`)),
    };
    const tehnoLine = await apply(sessions.tehnomaster, {
        product_code: 'CREDIT_LINE',
        purpose: 'WORKING_CAPITAL',
        amount: 5_000_000,
        term_months: 18,
    });
    scenarios['tehnomaster-credit-line'] = {
        login: 'tehnomaster',
        request: { product_code: 'CREDIT_LINE', purpose: 'WORKING_CAPITAL', amount: 5_000_000, term_months: 18 },
        application: compactApp(tehnoLine),
        dossier: compactDossier(await analyst.get(`/api/bank/applications/${tehnoLine.id}/dossier`)),
    };
    log('tehnomaster: два варианта, кредитная линия');

    // С4. orlov: запрос выписки → загрузка → повторная проверка
    const orlov = sessions.orlov;
    const orlovApp = await apply(orlov, {
        product_code: 'EXPRESS',
        purpose: 'WORKING_CAPITAL',
        amount: 1_500_000,
        term_months: 24,
    });
    const orlovNeedDossier = await analyst.get(`/api/bank/applications/${orlovApp.id}/dossier`);
    companySources.orlov = sourcesOf(orlovNeedDossier);
    const orlovRequest = orlovApp.info_requests.find((r) => r.status === 'OPEN');
    errors.answer_without_statement = await orlov.error('POST', `/api/info-requests/${orlovRequest.id}/answer`, {
        text: 'Выписку пришлю позже',
    });
    const badForm = new FormData();
    badForm.append('file', new Blob(['not a statement'], { type: 'text/plain' }), 'notes.txt');
    badForm.append('kind', 'BANK_STATEMENT');
    errors.upload_bad_statement = await orlov.error('POST', `/api/applications/${orlovApp.id}/documents`, undefined, {
        form: badForm,
    });
    const agreementForm = new FormData();
    agreementForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    agreementForm.append('kind', 'AGREEMENT');
    errors.upload_agreement_kind = await orlov.error('POST', `/api/applications/${orlovApp.id}/documents`, undefined, {
        form: agreementForm,
    });
    const exeForm = new FormData();
    exeForm.append('file', new Blob(['MZ'], { type: 'application/octet-stream' }), 'tool.exe');
    exeForm.append('kind', 'OTHER');
    errors.upload_bad_extension = await orlov.error('POST', `/api/applications/${orlovApp.id}/documents`, undefined, {
        form: exeForm,
    });
    const statementBytes = await readFile(join(DEMO_FILES, 'vypiska_orlov_1c.txt'));
    const form = new FormData();
    form.append('file', new Blob([statementBytes], { type: 'text/plain' }), 'vypiska_orlov_1c.txt');
    form.append('kind', 'BANK_STATEMENT');
    form.append('info_request_id', orlovRequest.id);
    const uploaded = (
        await call('POST', `/api/applications/${orlovApp.id}/documents`, { token: orlov.token, form, expect: 201 })
    ).data;
    examples.document = uploaded;
    await orlov.post(`/api/info-requests/${orlovRequest.id}/answer`, { text: 'Выписка за 12 месяцев' });
    const orlovRechecking = await orlov.get(`/api/applications/${orlovApp.id}`);
    const orlovOffer = await settle(orlov, orlovApp.id);
    scenarios['orlov-statement'] = {
        login: 'orlov',
        request: { product_code: 'EXPRESS', purpose: 'WORKING_CAPITAL', amount: 1_500_000, term_months: 24 },
        need_info: compactApp(orlovApp),
        need_info_dossier: compactDossier(orlovNeedDossier),
        uploaded: pick(uploaded, [
            'kind',
            'kind_label',
            'source',
            'file_name',
            'content_type',
            'size',
            'sha256',
            'parsed',
        ]),
        rechecking: compactApp(orlovRechecking),
        application: compactApp(orlovOffer),
        dossier: compactDossier(await analyst.get(`/api/bank/applications/${orlovApp.id}/dossier`)),
    };
    // Выписка CSV разбирается в черновике — только чтобы сохранить результат разбора
    const csvDraft = await orlov.post(
        '/api/applications',
        { product_code: 'EXPRESS', purpose: 'WORKING_CAPITAL', amount: 1_000_000, term_months: 12 },
        { expect: 201 },
    );
    const csvForm = new FormData();
    csvForm.append(
        'file',
        new Blob([await readFile(join(DEMO_FILES, 'vypiska_orlov.csv'))], { type: 'text/csv' }),
        'vypiska_orlov.csv',
    );
    csvForm.append('kind', 'BANK_STATEMENT');
    const csvUploaded = (
        await call('POST', `/api/applications/${csvDraft.id}/documents`, {
            token: orlov.token,
            form: csvForm,
            expect: 201,
        })
    ).data;
    await orlov.del(`/api/documents/${csvUploaded.id}`, { expect: 204 });
    // Выписка с кассовым разрывом — для прогноза денежного потока
    const gapForm = new FormData();
    gapForm.append(
        'file',
        new Blob([await readFile(join(DEMO_FILES, 'vypiska_smirnova.csv'))], { type: 'text/csv' }),
        'vypiska_smirnova.csv',
    );
    gapForm.append('kind', 'BANK_STATEMENT');
    const gapUploaded = (
        await call('POST', `/api/applications/${csvDraft.id}/documents`, {
            token: orlov.token,
            form: gapForm,
            expect: 201,
        })
    ).data;
    await orlov.del(`/api/documents/${gapUploaded.id}`, { expect: 204 });
    await orlov.del(`/api/applications/${csvDraft.id}`, { expect: 204 });
    errors.deleted_draft = await orlov.error('GET', `/api/applications/${csvDraft.id}`);
    const statements = {
        'vypiska_orlov_1c.txt': uploaded.parsed,
        'vypiska_orlov.csv': csvUploaded.parsed,
        'vypiska_smirnova.csv': gapUploaded.parsed,
    };
    log('orlov: выписка разобрана, одобрено');

    // С7. start: молодой бизнес — продукт для начинающих, ручное рассмотрение, отказ аналитика
    const startQuote = (
        await call('POST', '/api/calculator/quote', {
            json: {
                purpose: 'WORKING_CAPITAL',
                amount: 1_500_000,
                term_months: 24,
                business_months: 5,
                is_bank_client: true,
                account_months: 5,
            },
        })
    ).data;
    const startApp = await apply(sessions.start, {
        product_code: 'STARTUP',
        purpose: 'WORKING_CAPITAL',
        amount: 1_500_000,
        term_months: 24,
    });
    const startDossier = await analyst2.get(`/api/bank/applications/${startApp.id}/dossier`);
    companySources.start = sourcesOf(startDossier);
    errors.request_unknown_item = await analyst2.error('POST', `/api/bank/applications/${startApp.id}/info-requests`, {
        items: ['UNKNOWN'],
        comment: '',
        due_hours: 24,
    });
    await analyst2.post(`/api/bank/applications/${startApp.id}/decision`, {
        action: 'REJECT',
        reason_code: 'R01',
        comment: 'Недостаточная история бизнеса',
    });
    scenarios['start-young'] = {
        login: 'start',
        request: { product_code: 'STARTUP', purpose: 'WORKING_CAPITAL', amount: 1_500_000, term_months: 24 },
        quote: startQuote.map((q) => ({ code: q.product.code, eligible: q.eligible, issues: q.issues })),
        review: compactApp(startApp),
        dossier: compactDossier(startDossier),
        application: compactApp(await sessions.start.get(`/api/applications/${startApp.id}`)),
        dossier_rejected: compactDossier(await analyst2.get(`/api/bank/applications/${startApp.id}/dossier`), false),
    };
    log('start: ручное рассмотрение и отказ');

    // С8. Стоп-факторы
    for (const login of ['romashka', 'meridian']) {
        const app = await apply(sessions[login], {
            product_code: 'GROWTH',
            purpose: 'WORKING_CAPITAL',
            amount: 2_000_000,
            term_months: 24,
        });
        const dossier = await analyst.get(`/api/bank/applications/${app.id}/dossier`);
        companySources[login] = sourcesOf(dossier);
        scenarios[`${login}-stop`] = {
            login,
            request: { product_code: 'GROWTH', purpose: 'WORKING_CAPITAL', amount: 2_000_000, term_months: 24 },
            application: compactApp(app),
            dossier: compactDossier(dossier),
        };
    }
    log('romashka, meridian: отказ по стоп-факторам');

    // С9. altair: обычная заявка, затем сбой БКИ, ожидание источника и восстановление
    const altair = sessions.altair;
    const altairApp = await apply(altair, {
        product_code: 'EXPRESS',
        purpose: 'WORKING_CAPITAL',
        amount: 2_000_000,
        term_months: 12,
    });
    const altairDossier = await analyst.get(`/api/bank/applications/${altairApp.id}/dossier`);
    companySources.altair = sourcesOf(altairDossier);
    scenarios['altair-approve'] = {
        login: 'altair',
        request: { product_code: 'EXPRESS', purpose: 'WORKING_CAPITAL', amount: 2_000_000, term_months: 12 },
        application: compactApp(altairApp),
        dossier: compactDossier(altairDossier),
    };
    errors.analyst_sets_fault = await analyst.error('PUT', '/api/admin/simulator/faults/bki', { mode: 'error' });
    errors.unknown_fault_source = await admin.error('PUT', '/api/admin/simulator/faults/unknown', { mode: 'error' });
    const faultsError = await admin.put('/api/admin/simulator/faults/bki', { mode: 'error', latency_ms: 0 });
    const outage = await altair.post(
        '/api/applications',
        { product_code: 'EXPRESS', purpose: 'WORKING_CAPITAL', amount: 2_000_000, term_months: 12 },
        { expect: 201 },
    );
    await altair.post(`/api/applications/${outage.id}/submit`, { consent_bki: true, consent_pd: true });
    const waiting = await waitFor(async () => {
        const app = await altair.get(`/api/applications/${outage.id}`);
        return app.steps.find((s) => s.step === 'BKI')?.status === 'WAITING' ? app : null;
    }, 'ожидание БКИ');
    const waitingBankView = await analyst.get(`/api/applications/${outage.id}`);
    const waitingDossier = await analyst.get(`/api/bank/applications/${outage.id}/dossier`);
    const waitingIssues = await analyst.get('/api/bank/pipeline/issues');
    const waitingSummary = await analyst.get('/api/bank/summary');
    const waitingQueue = (await analyst.get('/api/bank/applications?status=SUBMITTED&status=IN_PROCESSING')).find(
        (r) => r.id === outage.id,
    );
    examples.pipeline_issues = waitingIssues;
    examples.application_waiting = waiting;
    // Таймаут вместо ошибки: другой текст ошибки шага
    await admin.put('/api/admin/simulator/faults/bki', { mode: 'timeout', latency_ms: 0 });
    const timeoutStep = await waitFor(
        async () => {
            const dossier = await analyst.get(`/api/bank/applications/${outage.id}/dossier`);
            const error = dossier.sources.BKI.error ?? '';
            return error.includes('время') || error.includes('приостановлены') ? dossier.sources.BKI : null;
        },
        'ошибка таймаута БКИ',
        120_000,
    );
    const faultsReset = await admin.post('/api/admin/simulator/faults/reset');
    await analyst.post(`/api/bank/applications/${outage.id}/pipeline/retry`);
    const recovered = await settle(altair, outage.id);
    scenarios['altair-outage'] = {
        login: 'altair',
        request: { product_code: 'EXPRESS', purpose: 'WORKING_CAPITAL', amount: 2_000_000, term_months: 12 },
        waiting: compactApp(waiting),
        waiting_bank_view: compactApp(waitingBankView),
        waiting_dossier: compactDossier(waitingDossier),
        waiting_issues: waitingIssues.map((i) =>
            pick(i, ['number', 'company_name', 'status', 'step', 'step_title', 'step_status', 'attempts', 'error']),
        ),
        waiting_summary: waitingSummary,
        waiting_queue_item: pick(waitingQueue, [
            'status',
            'status_label',
            'waiting_source',
            'risk_class',
            'score',
            'flags',
        ]),
        timeout_step: pick(timeoutStep, ['status', 'error', 'attempts']),
        application: compactApp(recovered),
        dossier: compactDossier(await analyst.get(`/api/bank/applications/${outage.id}/dossier`)),
    };
    log('altair: ожидание БКИ и восстановление');

    // Права доступа и ошибки
    errors.login_wrong_password = await (async () => {
        const response = await call('POST', '/api/auth/login', {
            json: { login: 'veter', password: 'wrong' },
            raw: true,
        });
        return { status: response.status, detail: (await response.json()).detail };
    })();
    errors.me_without_token = await (async () => {
        const response = await call('GET', '/api/me', { raw: true });
        return { status: response.status, detail: (await response.json()).detail };
    })();
    errors.client_bank_summary = await veter.error('GET', '/api/bank/summary');
    errors.client_faults = await veter.error('GET', '/api/admin/simulator/faults');
    errors.analyst_client_list = await analyst.error('GET', '/api/applications');
    errors.analyst_company = await analyst.error('GET', '/api/company');
    errors.analyst_reset = await analyst.error('POST', '/api/admin/demo/reset');
    errors.unknown_path = await veter.error('GET', '/api/unknown');
    errors.wrong_method = await veter.error('DELETE', '/api/meta');
    errors.unknown_product = await veter.error('POST', '/api/applications', {
        product_code: 'NOPE',
        purpose: 'WORKING_CAPITAL',
        amount: 1_000_000,
        term_months: 12,
    });
    errors.negative_amount = await veter.error('POST', '/api/applications', {
        product_code: 'GROWTH',
        purpose: 'WORKING_CAPITAL',
        amount: -1,
        term_months: 12,
    });
    errors.parse_need_short = await veter.error('POST', '/api/ai/parse-need', { text: 'ab' });
    errors.ai_summary = await analyst.error('GET', `/api/bank/applications/${grandId}/ai-summary`);
    const ineligible = await sessions.start.post(
        '/api/applications',
        { product_code: 'GROWTH', purpose: 'WORKING_CAPITAL', amount: 2_000_000, term_months: 24 },
        { expect: 201 },
    );
    errors.submit_ineligible = await sessions.start.error('POST', `/api/applications/${ineligible.id}/submit`, {
        consent_bki: true,
        consent_pd: true,
    });
    errors.submit_without_consent = await sessions.start.error('POST', `/api/applications/${ineligible.id}/submit`, {
        consent_bki: false,
        consent_pd: true,
    });
    await sessions.start.del(`/api/applications/${ineligible.id}`, { expect: 204 });
    const securedDraft = await sessions.grand.post(
        '/api/applications',
        { product_code: 'SECURED', purpose: 'EXPANSION', amount: 10_000_000, term_months: 60 },
        { expect: 201 },
    );
    errors.submit_without_collateral = await sessions.grand.error(
        'POST',
        `/api/applications/${securedDraft.id}/submit`,
        { consent_bki: true, consent_pd: true },
    );
    await sessions.grand.del(`/api/applications/${securedDraft.id}`, { expect: 204 });

    // Итог: уведомления, журнал, очередь
    const notifications = {};
    for (const login of [...CLIENTS, 'analyst', 'admin']) {
        notifications[login] = compactNotifications(await sessions[login].get('/api/notifications'));
    }
    const veterNotifications = await veter.get('/api/notifications');
    examples.notifications = { ...veterNotifications, items: veterNotifications.items.slice(0, 2) };
    const auditRows = await admin.get('/api/admin/audit');
    examples.audit = auditRows.slice(0, 2);
    examples.audit_actions = auditRows.slice(0, 40).map((r) => r.action);
    examples.queue_closed = (await analyst.get('/api/bank/applications?include_closed=true')).map((r) =>
        pick(r, ['number', 'status', 'status_label', 'risk_class', 'score', 'flags']),
    );
    examples.summary_end = await analyst.get('/api/bank/summary');
    examples.metrics_end = await analyst.get('/api/bank/metrics?days=30');
    examples.faults = { initial: faultsInitial, bki_error: faultsError, reset: faultsReset };

    // Сохраняем
    await mkdir(FIXTURES, { recursive: true });
    const companiesFixture = {
        captured_at: capturedAt,
        captured_on: capturedAt.slice(0, 10),
        companies: Object.fromEntries(
            CLIENTS.map((login) => [login, { company: companies[login], sources: companySources[login] }]),
        ),
    };
    const write = async (name, data) => {
        const text = `${formatJson(data)}\n`;
        await writeFile(join(FIXTURES, name), text);
        log(`${name}: ${(text.length / 1024).toFixed(1)} КБ`);
    };
    await write('meta.json', meta);
    await write('products.json', products);
    await write('users.json', { captured_at: capturedAt, password: PASSWORD, users });
    await write('companies.json', companiesFixture);
    await write('faults.json', faultsInitial);
    await write('agreement.json', agreementInfo);
    await write('ai-status.json', aiStatus);
    await write('ai-golden.json', aiGolden);
    await write('statements.json', statements);
    await write('quotes.json', quotes);
    await write('previews.json', previews);
    await write('scenarios.json', scenarios);
    await write('notifications.json', notifications);
    await write('errors.json', errors);
    await write('examples.json', examples);

    await admin.post('/api/admin/demo/reset');
    log('демо-данные стенда сброшены');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
