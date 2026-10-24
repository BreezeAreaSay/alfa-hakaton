// Исходные демо-данные — как backend/app/seed/demo.py: сбой источников снят, заявки vektor и grand
// отправлены, распределены между аналитиками и уходят к ним.
import type { Purpose } from '../api/types';
import { FAULT_SOURCES, FIXTURES_VERSION, USERS, companyIds, userByLogin } from './data';
import { pickAnalyst } from './engine/review';
import { type AppRow, type DemoState, iso, uuid } from './model';
import { drain } from './pipeline';
import { analystLoads, assignAutomatically, transition } from './workflow';

// 2 — у событий появился адресат-сотрудник (user_id), у стартовых заявок — исполнитель
export const STATE_VERSION = 2;

interface Preseed {
    login: string;
    product_code: string;
    purpose: Purpose;
    purpose_text: string;
    amount: number;
    term_months: number;
    declared_revenue: number;
    collateral_type?: string;
    collateral_value?: number;
}

// Заявки, которые после сброса сразу уходят в конвейер и попадают в очередь аналитика.
const PRESEED: Preseed[] = [
    {
        login: 'vektor',
        product_code: 'GROWTH',
        purpose: 'EXPANSION',
        purpose_text: 'Покупка двух грузовых автомобилей и расширение автопарка',
        amount: 12_000_000,
        term_months: 36,
        declared_revenue: 36_000_000,
    },
    {
        login: 'grand',
        product_code: 'SECURED',
        purpose: 'EXPANSION',
        purpose_text: 'Строительство складского комплекса',
        amount: 60_000_000,
        term_months: 84,
        declared_revenue: 420_000_000,
        collateral_type: 'Коммерческая недвижимость',
        collateral_value: 120_000_000,
    },
];

export function nextNumber(state: DemoState, now: number): string {
    state.seq.app += 1;
    return `${new Date(now).getUTCFullYear()}-${String(state.seq.app).padStart(5, '0')}`;
}

function preseed(state: DemoState, now: number): number {
    // Стартовые заявки распределяются сразу, тем же правилом и по порядку номеров, будто пришли на рассмотрение
    // одна за другой, — как на стенде, где без этого исполнитель зависел бы от того, какая заявка первой пройдёт
    // параллельный конвейер
    const loads = analystLoads(state);
    for (const spec of PRESEED) {
        const user = userByLogin(spec.login);
        if (!user?.company_id) continue;
        const app: AppRow = {
            id: uuid(),
            number: nextNumber(state, now),
            company_id: user.company_id,
            created_by: user.id,
            product_code: spec.product_code,
            purpose: spec.purpose,
            purpose_text: spec.purpose_text,
            amount: spec.amount,
            term_months: spec.term_months,
            declared_revenue: spec.declared_revenue,
            collateral_type: spec.collateral_type ?? null,
            collateral_value: spec.collateral_value ?? null,
            status: 'DRAFT',
            created_at: iso(now),
            submitted_at: null,
            status_changed_at: iso(now),
            closed_at: null,
            sla_due_at: null,
            assignee_id: null,
            run_no: 0,
            consents: true,
            ai_parsed: null,
        };
        state.applications.push(app);
        transition(state, app, 'SUBMITTED', now, { actor: 'CLIENT', user });
        const login = pickAnalyst(loads);
        if (login) {
            assignAutomatically(state, app, login, now);
            loads[login] += 1;
        }
    }
    return PRESEED.length;
}

function emptyState(now: number, previous: DemoState | null): DemoState {
    return {
        version: STATE_VERSION,
        fixtures: FIXTURES_VERSION,
        created_at: iso(now),
        // Номера событий не начинаются заново: открытые вкладки продолжают поток с последнего Last-Event-ID
        seq: {
            app: 0,
            event: previous?.seq.event ?? 0,
            audit: 0,
            message: 0,
            decision: 0,
            scoring: 0,
            history: 0,
            job: 0,
        },
        faults: Object.fromEntries(FAULT_SOURCES.map((f) => [f.source, { mode: 'ok' as const, latency_ms: 0 }])),
        last_read: Object.fromEntries(USERS.map((u) => [u.id, 0])),
        synced_at: previous?.synced_at ?? Object.fromEntries(companyIds().map((id) => [id, iso(now)])),
        applications: [],
        steps: [],
        scorings: [],
        decisions: [],
        offers: [],
        info_requests: [],
        documents: [],
        signatures: [],
        loans: [],
        history: [],
        messages: [],
        support: [],
        events: [],
        audit: [],
        jobs: [],
        idempotency: [],
        // Компании из конструктора администратора сброс не удаляет — как и учётные записи на стенде
        custom_companies: previous?.custom_companies ?? [],
    };
}

/** Первое открытие демо-версии: стартовые заявки уже прошли конвейер минуту назад. */
export function initialState(now: number): DemoState {
    const state = emptyState(now, null);
    const start = now - 60_000;
    preseed(state, start);
    drain(state, start);
    return state;
}

/** Сброс администратором: данные как после первого открытия, стартовые заявки идут по конвейеру заново. */
export function resetState(previous: DemoState, now: number): { state: DemoState; preseeded: number } {
    const state = emptyState(now, previous);
    const preseeded = preseed(state, now);
    return { state, preseeded };
}
