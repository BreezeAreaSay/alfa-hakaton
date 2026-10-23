// Обработчики API имитации — порт backend/app/api/*.py: те же проверки, коды ответов и тексты ошибок.
import type { AppStatus, Purpose, Role } from '../api/types';
import { AGREEMENT, DEMO_PASSWORD, FAULT_SOURCES, META, companyProfile, userById, userByLogin } from './data';
import { parseNeedRules } from './engine/ai';
import { PRODUCT_ROWS, productRow, productTerms, productsForPurpose } from './engine/catalog';
import { todayUtc } from './engine/dates';
import { type PolicyDecision, eligibilityIssues, newDecision, note, offerFigures, paymentLabel } from './engine/policy';
import { StatementError, parseStatement } from './engine/statements';
import aiStatusFixture from './fixtures/ai-status.json';
import { type Body, HttpError, Validator, json, noContent } from './http';
import { type AppRow, type DemoState, type DemoUser, type FaultMode, type SupportRow, iso, uuid } from './model';
import { findApp, resetBreakers, saveDecision } from './pipeline';
import { kick } from './scheduler';
import { nextNumber, resetState } from './seed';
import { files, getState, replaceState, transact } from './store';
import { openStream } from './stream';
import {
    applicationOut,
    auditOut,
    PROACTIVE_UNAVAILABLE,
    bankMetrics,
    bankSummary,
    companyOut,
    documentsOut,
    dossierOut,
    inScope,
    listItem,
    loanOut,
    money,
    notificationsOut,
    pipelineIssues,
    queueItems,
    termsFor,
    userOut,
    proactiveOffersOut,
} from './views';
import { audit, emit, refresh, transition } from './workflow';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OFFER_TTL_HOURS = 7 * 24;
const MAX_UPLOAD_MB = 10;
const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.txt', '.csv'];
const PURPOSES: Purpose[] = ['WORKING_CAPITAL', 'CASH_GAP', 'EQUIPMENT', 'EXPANSION'];
const DOCUMENT_KINDS = ['BANK_STATEMENT', 'FIN_STATEMENT', 'COLLATERAL', 'OTHER', 'AGREEMENT', 'SCHEDULE'] as const;
const STATUSES = Object.keys(META.statuses) as AppStatus[];
const REASON_CODES = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07'] as const;
const FAULT_MODES = ['ok', 'error', 'timeout', 'slow'] as const;

export interface Ctx {
    method: string;
    url: URL;
    params: Record<string, string>;
    headers: Headers;
    body: Body;
    form: FormData | null;
    now: number;
}

// ---------------------------------------------------------------- доступ

const TOKEN_PREFIX = 'demo.';

const tokenFor = (user: DemoUser): string => `${TOKEN_PREFIX}${user.id}.${uuid().replaceAll('-', '')}`;

function currentUser(ctx: Ctx): DemoUser {
    const header = ctx.headers.get('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = token.startsWith(TOKEN_PREFIX) ? userById(token.slice(TOKEN_PREFIX.length).split('.')[0]) : undefined;
    if (!user) throw new HttpError(401, 'Нужно войти заново');
    return user;
}

function requireRoles(ctx: Ctx, ...roles: Role[]): DemoUser {
    const user = currentUser(ctx);
    if (!roles.includes(user.role)) throw new HttpError(403, 'Недостаточно прав');
    return user;
}

const clientOnly = (ctx: Ctx) => requireRoles(ctx, 'CLIENT');
const bankStaff = (ctx: Ctx) => requireRoles(ctx, 'UNDERWRITER', 'ADMIN');
const adminOnly = (ctx: Ctx) => requireRoles(ctx, 'ADMIN');

/** Клиент видит только заявки своей компании, сотрудники банка — все, кроме черновиков. */
function load(state: DemoState, id: string, user: DemoUser): AppRow {
    const app = findApp(state, id);
    if (!app) throw new HttpError(404, 'Заявка не найдена');
    if (user.role === 'CLIENT' && app.company_id !== user.company_id) throw new HttpError(404, 'Заявка не найдена');
    if (user.role !== 'CLIENT' && app.status === 'DRAFT') throw new HttpError(404, 'Заявка не найдена');
    return app;
}

function loadForBank(state: DemoState, id: string): AppRow {
    const app = findApp(state, id);
    if (!app || app.status === 'DRAFT') throw new HttpError(404, 'Заявка не найдена');
    return app;
}

function idempotencyKey(ctx: Ctx): string | null {
    const key = ctx.headers.get('Idempotency-Key');
    if (key !== null && key.length > 128) {
        const v = new Validator({ 'Idempotency-Key': key }, 'header');
        v.string('Idempotency-Key', { max: 128 });
        v.done();
    }
    return key || null;
}

const actorOf = (user: DemoUser) => user.role;

/** Ключ идемпотентности: повтор запроса с ним вернёт текущую заявку, не повторяя действие. */
function remember(state: DemoState, key: string | null, scope: string): void {
    if (!key) return;
    state.idempotency.push(scope);
    if (state.idempotency.length > 200) state.idempotency = state.idempotency.slice(-200);
}

// ---------------------------------------------------------------- вход и справочники

function login(ctx: Ctx) {
    const v = new Validator(ctx.body);
    const name = v.string('login', { required: true });
    const password = v.string('password', { required: true });
    v.done();
    const user = userByLogin(String(name).trim().toLowerCase());
    if (!user || password !== DEMO_PASSWORD) throw new HttpError(401, 'Неверный логин или пароль');
    return transact((state) => {
        audit(state, ctx.now, { actor: actorOf(user), user, action: 'LOGIN', entity_type: 'user', entity_id: user.id });
        return { token: tokenFor(user), user: userOut(state, user, ctx.now) };
    });
}

function quote(ctx: Ctx) {
    const v = new Validator(ctx.body);
    const purpose = v.choice('purpose', PURPOSES, { required: true });
    const amount = v.number('amount', { required: true, gt: 0 });
    const term = v.number('term_months', { required: true, gt: 0, le: 240, int: true });
    v.choice('legal_form', ['OOO', 'IP'], { nullable: true });
    const businessMonths = v.number('business_months', { nullable: true, ge: 0, int: true });
    const isBankClient = v.boolean('is_bank_client') ?? false;
    const accountMonths = v.number('account_months', { ge: 0, int: true }) ?? 0;
    v.done();
    const age = businessMonths ?? null;
    const items = productsForPurpose(purpose as Purpose, age).flatMap((code) => {
        const product = productTerms(code);
        const row = productRow(code);
        if (!product || !row) return [];
        const issues = eligibilityIssues(product, {
            business_months: age,
            is_bank_client: isBankClient,
            account_months: accountMonths as number,
            amount: amount as number,
            term_months: term as number,
        });
        const clampedAmount = Math.min(Math.max(amount as number, product.min_amount), product.max_amount);
        const clampedTerm = Math.min(Math.max(term as number, product.min_term), product.max_term);
        const [monthly, over] = offerFigures(product, clampedAmount, product.base_rate, clampedTerm);
        return [
            {
                product: row,
                eligible: !issues.length,
                issues: issues.map((i) => i.text),
                rate_from: row.base_rate,
                monthly_payment: money(monthly),
                overpayment: money(over),
                payment_label: paymentLabel(product.kind),
            },
        ];
    });
    // Подходящие продукты — от меньшей ставки к большей, недоступные — после них в порядке уместности
    return items
        .map((item, index) => ({ item, index }))
        .sort(
            (a, b) =>
                Number(!a.item.eligible) - Number(!b.item.eligible) ||
                (a.item.eligible ? Number(a.item.rate_from) - Number(b.item.rate_from) : 0) ||
                a.index - b.index,
        )
        .map(({ item }) => item);
}

/** Внешняя система ответит, если для неё не включён сбой (профиль компании из ЕГРЮЛ и данных банка). */
const available = (state: DemoState, source: string): boolean =>
    !['error', 'timeout'].includes(state.faults[source]?.mode ?? 'ok');

function company(ctx: Ctx) {
    const user = clientOnly(ctx);
    const refreshParam = ['true', '1', 'yes', 'on'].includes((ctx.url.searchParams.get('refresh') ?? '').toLowerCase());
    const id = user.company_id as string;
    const state = getState();
    const synced = state.synced_at[id];
    const stale = !synced || Date.parse(synced) < ctx.now - DAY;
    if ((refreshParam || stale) && available(state, 'egrul') && available(state, 'bank')) {
        transact((current) => {
            current.synced_at[id] = iso(ctx.now);
        });
    }
    return companyOut(getState(), id, ctx.now);
}

// ---------------------------------------------------------------- заявки клиента

function draftFields(v: Validator, create: boolean) {
    return {
        // Обязательные поля можно не передавать при изменении, но нельзя очистить: null — ошибка 422, как на сервере
        product_code: v.string('product_code', { required: create }),
        purpose: v.choice('purpose', PURPOSES, { required: create }),
        purpose_text: v.string('purpose_text', { nullable: true, max: 500 }),
        amount: v.number('amount', { required: create, gt: 0 }),
        term_months: v.number('term_months', { required: create, gt: 0, le: 240, int: true }),
        declared_revenue: v.number('declared_revenue', { nullable: true, ge: 0 }),
        collateral_type: v.string('collateral_type', { nullable: true, max: 64 }),
        collateral_value: v.number('collateral_value', { nullable: true, ge: 0 }),
    };
}

function requireProduct(code: unknown) {
    const product = typeof code === 'string' ? productTerms(code) : undefined;
    if (!product) throw new HttpError(422, 'Такого продукта нет');
    return product;
}

function createDraft(ctx: Ctx) {
    const user = clientOnly(ctx);
    const v = new Validator(ctx.body);
    const fields = draftFields(v, true);
    const aiParsed = v.object('ai_parsed');
    v.done();
    const product = requireProduct(fields.product_code);
    const response = transact((state) => {
        const app: AppRow = {
            id: uuid(),
            number: nextNumber(state, ctx.now),
            company_id: user.company_id as string,
            created_by: user.id,
            product_code: product.code,
            purpose: fields.purpose as Purpose,
            purpose_text: fields.purpose_text ?? null,
            amount: fields.amount as number,
            term_months: fields.term_months as number,
            declared_revenue: fields.declared_revenue ?? null,
            collateral_type: fields.collateral_type ?? null,
            collateral_value: fields.collateral_value ?? null,
            status: 'DRAFT',
            created_at: iso(ctx.now),
            submitted_at: null,
            status_changed_at: iso(ctx.now),
            closed_at: null,
            sla_due_at: null,
            assignee_id: null,
            run_no: 0,
            consents: false,
            ai_parsed: (aiParsed as AppRow['ai_parsed']) ?? null,
        };
        state.applications.push(app);
        audit(state, ctx.now, {
            actor: 'CLIENT',
            user,
            action: 'DRAFT_CREATED',
            entity_type: 'application',
            entity_id: app.id,
            details: { product: product.code, amount: app.amount },
        });
        return applicationOut(state, app, user, ctx.now);
    });
    return json(response, 201);
}

function myApplications(ctx: Ctx) {
    const user = clientOnly(ctx);
    return getState()
        .applications.filter((a) => a.company_id === user.company_id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(listItem);
}

function getApplication(ctx: Ctx) {
    const user = currentUser(ctx);
    const state = getState();
    return applicationOut(state, load(state, ctx.params.id, user), user, ctx.now);
}

function updateDraft(ctx: Ctx) {
    const user = clientOnly(ctx);
    const v = new Validator(ctx.body);
    const fields = draftFields(v, false);
    v.done();
    return transact((state) => {
        const app = load(state, ctx.params.id, user);
        if (app.status !== 'DRAFT') throw new HttpError(409, 'Изменить можно только черновик');
        if (fields.product_code !== undefined) requireProduct(fields.product_code);
        for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined) (app as unknown as Record<string, unknown>)[key] = value;
        }
        return applicationOut(state, app, user, ctx.now);
    });
}

function deleteDraft(ctx: Ctx) {
    const user = clientOnly(ctx);
    transact((state) => {
        const app = load(state, ctx.params.id, user);
        if (app.status !== 'DRAFT') {
            throw new HttpError(409, 'Удалить можно только черновик. Отправленную заявку можно отозвать');
        }
        for (const doc of state.documents.filter((d) => d.app_id === app.id)) files.delete(doc.id);
        state.documents = state.documents.filter((d) => d.app_id !== app.id);
        state.events = state.events.filter((e) => e.app_id !== app.id);
        audit(state, ctx.now, {
            actor: 'CLIENT',
            user,
            action: 'DRAFT_DELETED',
            entity_type: 'application',
            entity_id: app.id,
        });
        state.applications = state.applications.filter((a) => a.id !== app.id);
    });
    return noContent();
}

function submit(ctx: Ctx) {
    const user = clientOnly(ctx);
    const v = new Validator(ctx.body);
    const consentBki = v.boolean('consent_bki', { required: true });
    const consentPd = v.boolean('consent_pd', { required: true });
    v.done();
    const key = idempotencyKey(ctx);
    const result = transact((state) => {
        const app = load(state, ctx.params.id, user);
        const scope = `${user.id}:submit:${app.id}:${key}`;
        if (key && state.idempotency.includes(scope)) return applicationOut(state, app, user, ctx.now);
        if (app.status !== 'DRAFT') throw new HttpError(409, 'Заявка уже отправлена');
        if (!(consentBki && consentPd)) {
            throw new HttpError(
                422,
                'Без согласий на запрос в БКИ и обработку персональных данных мы не сможем рассмотреть заявку',
            );
        }
        const product = requireProduct(app.product_code);
        const profile = companyProfile(app.company_id, todayUtc(ctx.now), null);
        const issues = eligibilityIssues(product, {
            business_months: profile.business_months,
            is_bank_client: profile.is_bank_client,
            account_months: profile.account_months ?? 0,
            amount: app.amount,
            term_months: app.term_months,
        });
        if (issues.length) throw new HttpError(422, issues.map((i) => i.text).join('; '));
        if (product.collateral_required && !app.collateral_value) {
            throw new HttpError(422, 'Укажите залог и его оценочную стоимость');
        }
        app.consents = true;
        transition(state, app, 'SUBMITTED', ctx.now, { actor: 'CLIENT', user });
        remember(state, key, scope);
        return applicationOut(state, app, user, ctx.now);
    });
    kick();
    return result;
}

function cancel(ctx: Ctx) {
    const user = clientOnly(ctx);
    return transact((state) => {
        const app = load(state, ctx.params.id, user);
        transition(state, app, 'CANCELLED', ctx.now, { actor: 'CLIENT', user, reason: 'Отозвана клиентом' });
        for (const offer of state.offers.filter((o) => o.app_id === app.id && o.status === 'ACTIVE')) {
            offer.status = 'VOID';
        }
        for (const request of state.info_requests.filter((r) => r.app_id === app.id && r.status === 'OPEN')) {
            request.status = 'CANCELLED';
        }
        return applicationOut(state, app, user, ctx.now);
    });
}

/** Имя файла как на сервере: без пути, только буквы, цифры, точка, дефис и пробел. */
function safeName(fileName: string): string {
    const base = fileName.split('/').pop() ?? '';
    const name = base.replace(/[^\p{L}\p{N}_.\- ]/gu, '_').trim() || 'file';
    return name.slice(0, 120);
}

async function sha256(data: Uint8Array): Promise<string> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // без защищённого контекста SubtleCrypto недоступен — отпечаток условный
    let hash = 0x811c9dc5;
    for (const byte of data) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash.toString(16).padStart(8, '0').repeat(8);
}

async function upload(ctx: Ctx) {
    const user = currentUser(ctx);
    const form = ctx.form ?? new FormData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
        throw new HttpError(422, [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }]);
    }
    const v = new Validator({ kind: form.get('kind') ?? undefined });
    const kind = v.choice('kind', DOCUMENT_KINDS) ?? 'OTHER';
    v.done();
    const infoRequestId = (form.get('info_request_id') as string | null) || null;
    const blob = file;
    const fileName = (blob as File).name || '';
    const data = new Uint8Array(await blob.arrayBuffer());

    // Проверки до записи, как в обработчике сервера
    const state = getState();
    const app = load(state, ctx.params.id, user);
    if (kind === 'AGREEMENT' || kind === 'SCHEDULE') throw new HttpError(422, 'Этот тип документа формирует банк');
    const allowed = user.role === 'CLIENT' ? ['DRAFT', 'NEED_INFO'] : ['MANUAL_REVIEW'];
    if (!allowed.includes(app.status)) throw new HttpError(409, 'Сейчас нельзя добавить документ к заявке');
    if (infoRequestId !== null) {
        const request = state.info_requests.find((r) => r.id === infoRequestId);
        if (!request || request.app_id !== app.id || request.status !== 'OPEN') {
            throw new HttpError(422, 'Запрос банка не найден или уже закрыт');
        }
    }
    let parsed = null;
    if (kind === 'BANK_STATEMENT') {
        try {
            parsed = parseStatement(fileName || 'statement', data);
        } catch (error) {
            if (error instanceof StatementError) {
                throw new HttpError(422, `Не удалось разобрать выписку: ${error.message}`);
            }
            throw error;
        }
    }
    const source = user.role === 'CLIENT' ? 'CLIENT' : 'BANK';
    const name = safeName(fileName || 'file');
    if (data.length === 0) throw new HttpError(422, 'Файл пустой');
    if (data.length > MAX_UPLOAD_MB * 1024 * 1024) throw new HttpError(422, `Файл больше ${MAX_UPLOAD_MB} МБ`);
    const extension = (fileName || 'file').toLowerCase().match(/\.[^./]*$/)?.[0] ?? '';
    if (source === 'CLIENT' && !ALLOWED_EXTENSIONS.includes(extension)) {
        throw new HttpError(422, 'Можно загрузить PDF, JPG, PNG, TXT или CSV');
    }
    const digest = await sha256(data);
    const id = uuid();
    const response = transact((current) => {
        const target = load(current, ctx.params.id, user);
        current.documents.push({
            id,
            app_id: target.id,
            kind,
            source,
            file_name: name,
            content_type: blob.type || 'application/octet-stream',
            size: data.length,
            sha256: digest,
            created_at: iso(ctx.now),
            info_request_id: infoRequestId,
            parsed,
            uploaded_by: user.id,
        });
        audit(current, ctx.now, {
            actor: actorOf(user),
            user,
            action: 'DOCUMENT_UPLOADED',
            entity_type: 'application',
            entity_id: target.id,
            details: { kind, file: name, sha256: digest },
        });
        refresh(current, target, ctx.now);
        return documentsOut(current, target).find((d) => d.id === id);
    });
    files.set(id, new Blob([data], { type: blob.type || 'application/octet-stream' }));
    return json(response, 201);
}

const disposition = (name: string) => `inline; filename*=UTF-8''${encodeURIComponent(name)}`;

async function download(ctx: Ctx) {
    const user = currentUser(ctx);
    const state = getState();
    const doc = state.documents.find((d) => d.id === ctx.params.id);
    if (!doc) throw new HttpError(404, 'Документ не найден');
    load(state, doc.app_id, user);
    const headers = { 'Content-Type': doc.content_type, 'Content-Disposition': disposition(doc.file_name) };
    if (doc.kind === 'AGREEMENT') {
        try {
            const pdf = await fetch(`${import.meta.env.BASE_URL}demo/agreement-sample.pdf`);
            if (pdf.ok) return new Response(await pdf.blob(), { headers });
        } catch {
            // файл договора не загрузился — отдаём пояснение ниже
        }
    }
    const content = files.get(doc.id);
    if (content) return new Response(content, { headers });
    const text =
        doc.kind === 'AGREEMENT'
            ? `Демо-версия: образец договора (${AGREEMENT.file_name}) сейчас недоступен.`
            : `Демо-версия без сервера: файл «${doc.file_name}» хранился только в памяти вкладки, ` +
              'после перезагрузки страницы его содержимого нет. Данные выписки и заявки сохранены.';
    return new Response(text, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': disposition(`${doc.file_name}.txt`),
        },
    });
}

function deleteDocument(ctx: Ctx) {
    const user = clientOnly(ctx);
    transact((state) => {
        const doc = state.documents.find((d) => d.id === ctx.params.id);
        if (!doc) throw new HttpError(404, 'Документ не найден');
        const app = load(state, doc.app_id, user);
        if (doc.source !== 'CLIENT' || !['DRAFT', 'NEED_INFO'].includes(app.status)) {
            throw new HttpError(409, 'Этот документ удалить нельзя');
        }
        state.documents = state.documents.filter((d) => d.id !== doc.id);
        files.delete(doc.id);
        refresh(state, app, ctx.now);
    });
    return noContent();
}

function answer(ctx: Ctx) {
    const user = clientOnly(ctx);
    const v = new Validator(ctx.body);
    const text = v.string('text', { nullable: true, max: 4000 }) ?? null;
    v.done();
    const result = transact((state) => {
        const request = state.info_requests.find((r) => r.id === ctx.params.id);
        if (!request) throw new HttpError(404, 'Запрос не найден');
        const app = load(state, request.app_id, user);
        if (request.status !== 'OPEN' || app.status !== 'NEED_INFO') {
            throw new HttpError(409, 'На этот запрос уже нельзя ответить');
        }
        const attached = state.documents.filter((d) => d.info_request_id === request.id);
        const needsStatement = request.items.some((item) => item.code === 'BANK_STATEMENT');
        if (needsStatement && !attached.some((d) => d.kind === 'BANK_STATEMENT' && d.parsed)) {
            throw new HttpError(422, 'Приложите выписку по счёту в формате 1С или CSV');
        }
        if (!attached.length && !(text && text.trim())) {
            throw new HttpError(422, 'Добавьте ответ или приложите документ');
        }
        request.status = 'ANSWERED';
        request.answer_text = text;
        request.answered_at = iso(ctx.now);
        const target = request.origin === 'SYSTEM' ? 'IN_PROCESSING' : 'MANUAL_REVIEW';
        transition(state, app, target, ctx.now, { actor: 'CLIENT', user, reason: 'Клиент ответил на запрос' });
        emit(state, app, ctx.now, {
            audience: 'BANK',
            kind: 'INFO_ANSWERED',
            title: `Клиент ответил на запрос по заявке № ${app.number}`,
            body: text,
        });
        return applicationOut(state, app, user, ctx.now);
    });
    kick();
    return result;
}

function messages(ctx: Ctx) {
    const user = currentUser(ctx);
    const state = getState();
    const app = load(state, ctx.params.id, user);
    return state.messages
        .filter((m) => m.app_id === app.id)
        .sort((a, b) => a.id - b.id)
        .map((m) => ({
            id: m.id,
            author_name: userById(m.author_id)?.full_name ?? '',
            author_role: m.author_role,
            text: m.text,
            created_at: m.created_at,
        }));
}

function sendMessage(ctx: Ctx) {
    const user = currentUser(ctx);
    const v = new Validator(ctx.body);
    const text = v.string('text', { required: true, min: 1, max: 4000 }) as string;
    v.done();
    const response = transact((state) => {
        const app = load(state, ctx.params.id, user);
        if (app.status === 'DRAFT') throw new HttpError(409, 'Чат доступен после отправки заявки');
        state.seq.message += 1;
        const message = {
            id: state.seq.message,
            app_id: app.id,
            author_id: user.id,
            author_role: user.role,
            text: text.trim(),
            created_at: iso(ctx.now),
        };
        state.messages.push(message);
        const fromClient = user.role === 'CLIENT';
        emit(state, app, ctx.now, {
            audience: fromClient ? 'BANK' : 'CLIENT',
            kind: 'MESSAGE',
            title: fromClient
                ? `Новое сообщение по заявке № ${app.number}`
                : `Сообщение от банка по заявке № ${app.number}`,
            body: text.slice(0, 200),
        });
        return {
            id: message.id,
            author_name: user.full_name,
            author_role: user.role,
            text: message.text,
            created_at: message.created_at,
        };
    });
    return json(response, 201);
}

// ---------------------------------------------------------------- поддержка (как backend/app/api/support.py)

/** Сообщения, которые читает reader: клиенту — ответы поддержки, администратору — сообщения клиента. */
const incoming = (row: SupportRow, reader: DemoUser) =>
    reader.role === 'CLIENT' ? row.author_role !== 'CLIENT' : row.author_role === 'CLIENT';

function supportMessageOut(row: SupportRow) {
    return {
        id: row.id,
        author_name: userById(row.author_id)?.full_name ?? '',
        author_role: row.author_role,
        text: row.text,
        created_at: row.created_at,
    };
}

function supportChatOut(state: DemoState, clientId: string, reader: DemoUser) {
    const rows = state.support.filter((r) => r.client_id === clientId).sort((a, b) => a.id - b.id);
    return {
        messages: rows.map(supportMessageOut),
        unread: rows.filter((r) => incoming(r, reader) && !r.read_at).length,
    };
}

function supportClient(clientId: string): DemoUser {
    const client = userById(clientId);
    if (!client || client.role !== 'CLIENT') throw new HttpError(404, 'Клиент не найден');
    return client;
}

function supportText(ctx: Ctx): string {
    const v = new Validator(ctx.body);
    const text = v.string('text', { required: true, min: 1, max: 4000 }) as string;
    v.done();
    return text.trim();
}

function addSupport(state: DemoState, clientId: string, author: DemoUser, text: string, now: number): SupportRow {
    state.seq.message += 1;
    const row: SupportRow = {
        id: state.seq.message,
        client_id: clientId,
        author_id: author.id,
        author_role: author.role,
        text,
        read_at: null,
        created_at: iso(now),
    };
    state.support.push(row);
    return row;
}

function markSupportRead(clientId: string, reader: DemoUser, now: number) {
    transact((state) => {
        state.support
            .filter((r) => r.client_id === clientId && incoming(r, reader) && !r.read_at)
            .forEach((r) => {
                r.read_at = iso(now);
            });
    });
    return noContent();
}

function supportChat(ctx: Ctx) {
    const user = clientOnly(ctx);
    return supportChatOut(getState(), user.id, user);
}

function supportWrite(ctx: Ctx) {
    const user = clientOnly(ctx);
    const text = supportText(ctx);
    const row = transact((state) => {
        const created = addSupport(state, user.id, user, text, ctx.now);
        emit(state, null, ctx.now, {
            audience: 'BANK',
            kind: 'SUPPORT',
            title: 'Новое сообщение в поддержку',
            body: text.slice(0, 200),
            notify: false,
        });
        return created;
    });
    return json(supportMessageOut(row), 201);
}

function supportReadMine(ctx: Ctx) {
    const user = clientOnly(ctx);
    return markSupportRead(user.id, user, ctx.now);
}

function supportThreads(ctx: Ctx) {
    adminOnly(ctx);
    const state = getState();
    const last = new Map<string, SupportRow>();
    const unread = new Map<string, number>();
    for (const row of state.support) {
        if ((last.get(row.client_id)?.id ?? 0) < row.id) last.set(row.client_id, row);
        if (row.author_role === 'CLIENT' && !row.read_at)
            unread.set(row.client_id, (unread.get(row.client_id) ?? 0) + 1);
    }
    return [...last.values()]
        .sort((a, b) => b.id - a.id)
        .map((row) => {
            const client = userById(row.client_id);
            return {
                client_id: row.client_id,
                client_name: client?.full_name ?? '',
                company_name: client?.company_id ? companyOut(state, client.company_id, ctx.now).name : null,
                last_text: row.text,
                last_author_role: row.author_role,
                last_at: row.created_at,
                unread: unread.get(row.client_id) ?? 0,
            };
        });
}

function supportThread(ctx: Ctx) {
    const user = adminOnly(ctx);
    return supportChatOut(getState(), supportClient(ctx.params.id).id, user);
}

function supportReply(ctx: Ctx) {
    const user = adminOnly(ctx);
    const client = supportClient(ctx.params.id);
    const text = supportText(ctx);
    const row = transact((state) => {
        const created = addSupport(state, client.id, user, text, ctx.now);
        emit(state, null, ctx.now, {
            audience: 'CLIENT',
            kind: 'SUPPORT',
            title: 'Ответ поддержки',
            body: text.slice(0, 200),
            notify: false,
            company_id: client.company_id,
        });
        emit(state, null, ctx.now, { audience: 'BANK', kind: 'SUPPORT', title: 'Ответ поддержки', notify: false });
        return created;
    });
    return json(supportMessageOut(row), 201);
}

function supportReadThread(ctx: Ctx) {
    const user = adminOnly(ctx);
    return markSupportRead(supportClient(ctx.params.id).id, user, ctx.now);
}

function acceptOffer(ctx: Ctx) {
    const user = clientOnly(ctx);
    const result = transact((state) => {
        const offer = state.offers.find((o) => o.id === ctx.params.id);
        if (!offer) throw new HttpError(404, 'Предложение не найдено');
        const app = load(state, offer.app_id, user);
        if (offer.status !== 'ACTIVE' || Date.parse(offer.valid_until) < ctx.now) {
            throw new HttpError(409, 'Предложение больше не действует');
        }
        for (const other of state.offers.filter((o) => o.app_id === app.id && o.status === 'ACTIVE')) {
            other.status = 'VOID';
        }
        offer.status = 'ACCEPTED';
        transition(state, app, 'ACCEPTED', ctx.now, {
            actor: 'CLIENT',
            user,
            reason: `Принят вариант ${offer.option_no}`,
        });
        return applicationOut(state, app, user, ctx.now);
    });
    kick();
    return result;
}

function decline(ctx: Ctx) {
    const user = clientOnly(ctx);
    return transact((state) => {
        const app = load(state, ctx.params.id, user);
        transition(state, app, 'DECLINED', ctx.now, { actor: 'CLIENT', user });
        for (const offer of state.offers.filter((o) => o.app_id === app.id && o.status === 'ACTIVE')) {
            offer.status = 'DECLINED';
        }
        return applicationOut(state, app, user, ctx.now);
    });
}

function sign(ctx: Ctx) {
    const user = clientOnly(ctx);
    const v = new Validator(ctx.body);
    const password = v.string('password', { required: true });
    v.done();
    const key = idempotencyKey(ctx);
    const result = transact((state) => {
        const app = load(state, ctx.params.id, user);
        const scope = `${user.id}:sign:${app.id}:${key}`;
        if (key && state.idempotency.includes(scope)) return applicationOut(state, app, user, ctx.now);
        if (app.status !== 'SIGNING') throw new HttpError(409, 'Договор сейчас нельзя подписать');
        if (!user.can_sign) throw new HttpError(403, 'У вас нет права подписи от имени компании');
        if (password !== DEMO_PASSWORD) throw new HttpError(422, 'Неверный пароль');
        const agreement = state.documents
            .filter((d) => d.app_id === app.id && d.kind === 'AGREEMENT')
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        if (!agreement) throw new HttpError(409, 'Договор ещё не сформирован');
        for (const role of ['CLIENT', 'BANK'] as const) {
            state.signatures.push({
                app_id: app.id,
                document_id: agreement.id,
                signer_role: role,
                signer_user_id: role === 'CLIENT' ? user.id : null,
                created_at: iso(ctx.now),
            });
        }
        audit(state, ctx.now, {
            actor: 'CLIENT',
            user,
            action: 'AGREEMENT_SIGNED',
            entity_type: 'application',
            entity_id: app.id,
            details: { document: agreement.id, sha256: agreement.sha256 },
        });
        transition(state, app, 'SIGNED', ctx.now, { actor: 'CLIENT', user });
        remember(state, key, scope);
        return applicationOut(state, app, user, ctx.now);
    });
    kick();
    return result;
}

function loan(ctx: Ctx) {
    const user = currentUser(ctx);
    const state = getState();
    return loanOut(state, load(state, ctx.params.id, user));
}

// ---------------------------------------------------------------- уведомления

function notifications(ctx: Ctx) {
    return notificationsOut(getState(), currentUser(ctx));
}

function markRead(ctx: Ctx) {
    const user = currentUser(ctx);
    transact((state) => {
        const ids = state.events.filter((e) => inScope(e, user)).map((e) => e.id);
        state.last_read[user.id] = ids.length ? Math.max(...ids) : 0;
    });
    return noContent();
}

function stream(ctx: Ctx, signal: AbortSignal | null | undefined) {
    const user = currentUser(ctx);
    return openStream(user, ctx.headers.get('Last-Event-ID'), signal ?? null);
}

// ---------------------------------------------------------------- рабочее место банка

const BOOL_TRUE = ['true', '1', 'yes', 'on'];
const BOOL_FALSE = ['false', '0', 'no', 'off'];

function queryBool(ctx: Ctx, name: string): boolean {
    const raw = ctx.url.searchParams.get(name);
    if (raw === null) return false;
    const value = raw.toLowerCase();
    if (BOOL_TRUE.includes(value)) return true;
    if (BOOL_FALSE.includes(value)) return false;
    const v = new Validator({ [name]: raw }, 'query');
    v.boolean(name);
    v.done();
    return false;
}

function summary(ctx: Ctx) {
    return bankSummary(getState(), bankStaff(ctx), ctx.now);
}

function proactive(ctx: Ctx) {
    const user = clientOnly(ctx);
    const state = getState();
    const companyId = user.company_id as string;
    const legalForm = companyProfile(companyId, todayUtc(ctx.now), null).legal_form;
    const needed = ['egrul', 'bank', ...(legalForm === 'OOO' ? ['girbo'] : [])];
    if (!needed.every((source) => available(state, source))) {
        return { offers: [], facts: [], note: PROACTIVE_UNAVAILABLE, computed_at: iso(ctx.now) };
    }
    return proactiveOffersOut(companyId, ctx.now);
}

function queryInt(ctx: Ctx, name: string, fallback: number, opts: { ge?: number; le?: number }): number {
    const raw = ctx.url.searchParams.get(name);
    if (raw === null) return fallback;
    const v = new Validator({ [name]: raw }, 'query');
    const value = v.number(name, { int: true, ...opts });
    v.done();
    return value ?? fallback;
}

function metrics(ctx: Ctx) {
    bankStaff(ctx);
    return bankMetrics(getState(), ctx.now, queryInt(ctx, 'days', 30, { ge: 1, le: 365 }));
}

function queue(ctx: Ctx) {
    const user = bankStaff(ctx);
    const status = ctx.url.searchParams.getAll('status');
    const v = new Validator(Object.fromEntries(status.map((s, i) => [String(i), s])), 'query');
    status.forEach((_, i) => v.choice(String(i), STATUSES));
    v.done();
    return queueItems(getState(), user, ctx.now, {
        status,
        product: ctx.url.searchParams.get('product') || null,
        risk_class: ctx.url.searchParams.get('risk_class') || null,
        mine: queryBool(ctx, 'mine'),
        q: ctx.url.searchParams.get('q'),
        include_closed: queryBool(ctx, 'include_closed'),
    });
}

function assign(ctx: Ctx) {
    const user = bankStaff(ctx);
    return transact((state) => {
        const app = loadForBank(state, ctx.params.id);
        if (app.status !== 'MANUAL_REVIEW' && app.status !== 'NEED_INFO') {
            throw new HttpError(409, 'Взять в работу можно заявку на ручном рассмотрении');
        }
        app.assignee_id = user.id;
        audit(state, ctx.now, {
            actor: 'UNDERWRITER',
            user,
            action: 'ASSIGNED',
            entity_type: 'application',
            entity_id: app.id,
        });
        return applicationOut(state, app, user, ctx.now);
    });
}

function dossier(ctx: Ctx) {
    const user = bankStaff(ctx);
    const state = getState();
    return dossierOut(state, loadForBank(state, ctx.params.id), user, ctx.now);
}

function termsPreview(ctx: Ctx) {
    bankStaff(ctx);
    const v = new Validator(ctx.body);
    const productCode = v.string('product_code', { required: true }) as string;
    const amount = v.number('amount', { required: true, gt: 0 }) as number;
    const term = v.number('term_months', { required: true, gt: 0, le: 240, int: true }) as number;
    const rate = v.number('rate', { nullable: true });
    v.done();
    const state = getState();
    const app = loadForBank(state, ctx.params.id);
    return termsFor(state, app, ctx.now, {
        product_code: productCode,
        amount,
        term_months: term,
        rate: rate ?? null,
        comment: 'preview',
    }).preview;
}

function decision(ctx: Ctx) {
    const user = bankStaff(ctx);
    const v = new Validator(ctx.body);
    const action = v.choice('action', ['APPROVE', 'COUNTER', 'REJECT'] as const, { required: true });
    const productCode = v.string('product_code', { nullable: true });
    const amount = v.number('amount', { nullable: true, gt: 0 });
    const term = v.number('term_months', { nullable: true, gt: 0, le: 240, int: true });
    const rate = v.number('rate', { nullable: true, gt: 0, le: 60 });
    const reasonCode = v.choice('reason_code', REASON_CODES, { nullable: true });
    const comment = v.string('comment', { nullable: true, max: 2000 }) ?? null;
    v.done();
    return transact((state) => {
        const app = loadForBank(state, ctx.params.id);
        if (app.status !== 'MANUAL_REVIEW') {
            throw new HttpError(409, 'Решение можно принять только по заявке на ручном рассмотрении');
        }
        app.assignee_id ??= user.id;

        if (action === 'REJECT') {
            if (!reasonCode) throw new HttpError(422, 'Укажите причину отказа');
            if (!(comment && comment.trim())) throw new HttpError(422, 'Добавьте комментарий к отказу');
            const d = newDecision('REJECT', { reason_codes: [reasonCode] });
            note(d, 'Решение аналитика', 'отказ', comment);
            saveDecision(state, app, d, ctx.now, { kind: 'MANUAL', user, comment });
            transition(state, app, 'REJECTED', ctx.now, {
                actor: 'UNDERWRITER',
                user,
                reason: `${reasonCode}: ${comment}`,
            });
            return applicationOut(state, app, user, ctx.now);
        }

        let code = app.product_code;
        let sum = app.amount;
        let months = app.term_months;
        if (action === 'COUNTER') {
            code = productCode || app.product_code;
            sum = amount || app.amount;
            months = term || app.term_months;
        }
        const terms = termsFor(state, app, ctx.now, {
            product_code: code,
            amount: sum,
            term_months: months,
            rate: rate ?? null,
            comment,
        });
        if (terms.preview.errors.length) throw new HttpError(422, terms.preview.errors.join('; '));
        const asRequested = code === app.product_code && sum === app.amount && months === app.term_months;
        const d: PolicyDecision = newDecision(asRequested ? 'APPROVE' : 'COUNTER', {
            rate: terms.rate,
            limit: terms.limit,
            limit_binding: terms.preview.limit_binding,
        });
        note(d, 'Решение аналитика', asRequested ? 'одобрено' : 'контрпредложение', comment ?? '');
        const saved = saveDecision(state, app, d, ctx.now, { kind: 'MANUAL', user, comment });
        state.offers.push({
            id: uuid(),
            app_id: app.id,
            decision_id: saved.id,
            option_no: 1,
            kind: asRequested ? 'AS_REQUESTED' : 'COUNTER',
            product_code: code,
            amount: sum,
            term_months: months,
            rate: terms.rate,
            monthly_payment: terms.monthly,
            overpayment: terms.over,
            valid_until: iso(ctx.now + OFFER_TTL_HOURS * HOUR),
            status: 'ACTIVE',
            note: asRequested ? null : 'Условия предложены специалистом банка',
            created_at: iso(ctx.now),
        });
        transition(state, app, 'OFFER', ctx.now, {
            actor: 'UNDERWRITER',
            user,
            reason: comment || (asRequested ? 'Одобрено' : 'Контрпредложение'),
        });
        return applicationOut(state, app, user, ctx.now);
    });
}

function requestInfo(ctx: Ctx) {
    const user = bankStaff(ctx);
    const v = new Validator(ctx.body);
    const items = v.stringList('items', { required: true, min: 1 }) as string[];
    const comment = v.string('comment', { nullable: true, max: 2000 }) ?? null;
    const dueHours = (v.number('due_hours', { ge: 1, le: 24 * 30, int: true }) ?? 72) as number;
    v.done();
    return transact((state) => {
        const app = loadForBank(state, ctx.params.id);
        if (app.status !== 'MANUAL_REVIEW') {
            throw new HttpError(409, 'Запросить информацию можно по заявке на ручном рассмотрении');
        }
        const presets = new Map(META.info_items.map((p) => [p.code, p]));
        const unknown = items.filter((code) => !presets.has(code));
        if (unknown.length) throw new HttpError(422, `Неизвестные пункты запроса: ${unknown.join(', ')}`);
        app.assignee_id ??= user.id;
        state.info_requests.push({
            id: uuid(),
            app_id: app.id,
            origin: 'UNDERWRITER',
            requested_by: user.id,
            items: items.map((code) => presets.get(code)!),
            comment,
            due_at: iso(ctx.now + dueHours * HOUR),
            status: 'OPEN',
            answer_text: null,
            answered_at: null,
            created_at: iso(ctx.now),
        });
        transition(state, app, 'NEED_INFO', ctx.now, {
            actor: 'UNDERWRITER',
            user,
            reason: items.map((code) => presets.get(code)!.title).join(', '),
        });
        return applicationOut(state, app, user, ctx.now);
    });
}

function restart(ctx: Ctx) {
    const user = bankStaff(ctx);
    const result = transact((state) => {
        const app = loadForBank(state, ctx.params.id);
        transition(state, app, 'IN_PROCESSING', ctx.now, {
            actor: 'UNDERWRITER',
            user,
            reason: 'Перезапуск автоматической проверки',
        });
        return applicationOut(state, app, user, ctx.now);
    });
    kick();
    return result;
}

function retryNow(ctx: Ctx) {
    const user = bankStaff(ctx);
    const result = transact((state) => {
        const app = loadForBank(state, ctx.params.id);
        for (const job of state.jobs.filter((j) => j.app_id === app.id && j.status === 'QUEUED')) job.run_at = ctx.now;
        audit(state, ctx.now, {
            actor: 'UNDERWRITER',
            user,
            action: 'PIPELINE_RETRY',
            entity_type: 'application',
            entity_id: app.id,
        });
        return applicationOut(state, app, user, ctx.now);
    });
    kick();
    return result;
}

function issues(ctx: Ctx) {
    bankStaff(ctx);
    return pipelineIssues(getState());
}

function aiSummary(ctx: Ctx) {
    bankStaff(ctx);
    throw new HttpError(404, 'ИИ-функции выключены');
}

// ---------------------------------------------------------------- администрирование демо

const faultList = (state: DemoState) =>
    FAULT_SOURCES.map(({ source, title }) => ({
        source,
        title,
        ...(state.faults[source] ?? { mode: 'ok', latency_ms: 0 }),
    }));

function demoReset(ctx: Ctx) {
    const user = adminOnly(ctx);
    const { state, preseeded } = resetState(getState(), ctx.now);
    audit(state, ctx.now, { actor: 'ADMIN', user, action: 'DEMO_RESET', entity_type: 'system', entity_id: 'demo' });
    resetBreakers();
    replaceState(state);
    kick();
    return { status: 'ok', preseeded };
}

function faults(ctx: Ctx) {
    bankStaff(ctx);
    return faultList(getState());
}

function setFault(ctx: Ctx) {
    const user = adminOnly(ctx);
    const v = new Validator(ctx.body);
    const mode = v.choice('mode', FAULT_MODES, { required: true }) as FaultMode;
    const latency = (v.number('latency_ms', { ge: 0, le: 20_000, int: true }) ?? 0) as number;
    v.done();
    const source = ctx.params.source;
    if (!FAULT_SOURCES.some((f) => f.source === source)) {
        throw new HttpError(404, `Неизвестная внешняя система: ${source}`);
    }
    const result = transact((state) => {
        state.faults[source] = { mode, latency_ms: latency };
        audit(state, ctx.now, {
            actor: 'ADMIN',
            user,
            action: 'FAULT_SET',
            entity_type: 'simulator',
            entity_id: source,
            details: { mode, latency_ms: latency },
        });
        return faultList(state);
    });
    kick();
    return result;
}

function resetFaults(ctx: Ctx) {
    const user = adminOnly(ctx);
    const result = transact((state) => {
        for (const { source } of FAULT_SOURCES) state.faults[source] = { mode: 'ok', latency_ms: 0 };
        audit(state, ctx.now, {
            actor: 'ADMIN',
            user,
            action: 'FAULTS_RESET',
            entity_type: 'simulator',
            entity_id: 'all',
        });
        return faultList(state);
    });
    kick();
    return result;
}

function auditLog(ctx: Ctx) {
    bankStaff(ctx);
    return auditOut(getState());
}

// ---------------------------------------------------------------- ИИ

function aiStatus(ctx: Ctx) {
    currentUser(ctx);
    return aiStatusFixture;
}

function parseNeed(ctx: Ctx) {
    currentUser(ctx);
    const v = new Validator(ctx.body);
    const text = v.string('text', { required: true, min: 3, max: 1000 }) as string;
    v.done();
    return parseNeedRules(text);
}

// ---------------------------------------------------------------- таблица маршрутов

export interface Route {
    method: string;
    pattern: RegExp;
    handler: (ctx: Ctx, signal?: AbortSignal | null) => unknown;
}

const route = (method: string, path: string, handler: Route['handler']): Route => ({
    method,
    pattern: new RegExp(`^${path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`),
    handler,
});

export const ROUTES: Route[] = [
    route('POST', '/api/auth/login', login),
    route('GET', '/api/me', (ctx) => userOut(getState(), currentUser(ctx), ctx.now)),
    route('GET', '/api/meta', () => META),
    route('GET', '/api/products', () => PRODUCT_ROWS),
    route('POST', '/api/calculator/quote', quote),
    route('GET', '/api/company', company),
    route('GET', '/api/offers/proactive', proactive),
    route('GET', '/api/applications', myApplications),
    route('POST', '/api/applications', createDraft),
    route('GET', '/api/applications/{id}', getApplication),
    route('PATCH', '/api/applications/{id}', updateDraft),
    route('DELETE', '/api/applications/{id}', deleteDraft),
    route('POST', '/api/applications/{id}/submit', submit),
    route('POST', '/api/applications/{id}/cancel', cancel),
    route('POST', '/api/applications/{id}/documents', upload),
    route('GET', '/api/documents/{id}/download', download),
    route('DELETE', '/api/documents/{id}', deleteDocument),
    route('POST', '/api/info-requests/{id}/answer', answer),
    route('GET', '/api/applications/{id}/messages', messages),
    route('POST', '/api/applications/{id}/messages', sendMessage),
    route('POST', '/api/offers/{id}/accept', acceptOffer),
    route('POST', '/api/applications/{id}/decline', decline),
    route('POST', '/api/applications/{id}/sign', sign),
    route('GET', '/api/applications/{id}/loan', loan),
    route('GET', '/api/notifications', notifications),
    route('POST', '/api/notifications/read', markRead),
    route('GET', '/api/support', supportChat),
    route('POST', '/api/support/messages', supportWrite),
    route('POST', '/api/support/read', supportReadMine),
    route('GET', '/api/support/threads', supportThreads),
    route('GET', '/api/support/threads/{id}', supportThread),
    route('POST', '/api/support/threads/{id}/messages', supportReply),
    route('POST', '/api/support/threads/{id}/read', supportReadThread),
    route('GET', '/api/stream', stream),
    route('GET', '/api/bank/summary', summary),
    route('GET', '/api/bank/metrics', metrics),
    route('GET', '/api/bank/applications', queue),
    route('POST', '/api/bank/applications/{id}/assign', assign),
    route('GET', '/api/bank/applications/{id}/dossier', dossier),
    route('POST', '/api/bank/applications/{id}/terms-preview', termsPreview),
    route('POST', '/api/bank/applications/{id}/decision', decision),
    route('POST', '/api/bank/applications/{id}/info-requests', requestInfo),
    route('POST', '/api/bank/applications/{id}/restart', restart),
    route('POST', '/api/bank/applications/{id}/pipeline/retry', retryNow),
    route('GET', '/api/bank/applications/{id}/ai-summary', aiSummary),
    route('GET', '/api/bank/pipeline/issues', issues),
    route('POST', '/api/admin/demo/reset', demoReset),
    route('GET', '/api/admin/simulator/faults', faults),
    route('PUT', '/api/admin/simulator/faults/{source}', setFault),
    route('POST', '/api/admin/simulator/faults/reset', resetFaults),
    route('GET', '/api/admin/audit', auditLog),
    route('GET', '/api/ai/status', aiStatus),
    route('POST', '/api/ai/parse-need', parseNeed),
    route('GET', '/api/health', () => ({ status: 'ok' })),
    route('GET', '/api/ready', () => ({ status: 'ready' })),
];
