// Машина состояний заявки, события и журнал — порт backend/app/services/workflow.py, events.py, audit.py.
import type { AppStatus } from '../api/types';
import { HttpError } from './http';
import { pickupDelay } from './timing';
import { META } from './data';
import type { Json } from './engine/features';
import {
    type Actor,
    type AppRow,
    type Audience,
    CANCELLABLE,
    type DemoState,
    type DemoUser,
    FINAL_STATUSES,
    type JobKind,
    PIPELINE_ORDER,
    type StepCode,
    iso,
} from './model';

const REVIEW_SLA_HOURS = 24;
const HOUR = 3_600_000;

const ALLOWED: Record<string, Actor[]> = {
    'DRAFT>SUBMITTED': ['CLIENT'],
    'SUBMITTED>IN_PROCESSING': ['SYSTEM'],
    'IN_PROCESSING>NEED_INFO': ['SYSTEM'],
    'IN_PROCESSING>MANUAL_REVIEW': ['SYSTEM'],
    'IN_PROCESSING>OFFER': ['SYSTEM'],
    'IN_PROCESSING>REJECTED': ['SYSTEM'],
    'NEED_INFO>IN_PROCESSING': ['CLIENT'],
    'NEED_INFO>MANUAL_REVIEW': ['CLIENT'],
    'NEED_INFO>EXPIRED': ['SYSTEM'],
    'MANUAL_REVIEW>OFFER': ['UNDERWRITER'],
    'MANUAL_REVIEW>NEED_INFO': ['UNDERWRITER'],
    'MANUAL_REVIEW>REJECTED': ['UNDERWRITER'],
    'MANUAL_REVIEW>IN_PROCESSING': ['UNDERWRITER'],
    'OFFER>ACCEPTED': ['CLIENT'],
    'OFFER>DECLINED': ['CLIENT'],
    'OFFER>EXPIRED': ['SYSTEM'],
    'ACCEPTED>SIGNING': ['SYSTEM'],
    'SIGNING>SIGNED': ['CLIENT'],
    'SIGNED>ISSUED': ['SYSTEM'],
};

export function canTransition(current: AppStatus, target: AppStatus, actor: Actor): boolean {
    if (target === 'CANCELLED') return CANCELLABLE.has(current) && actor === 'CLIENT';
    return (ALLOWED[`${current}>${target}`] ?? []).includes(actor);
}

const CLIENT_NOTICES: Partial<Record<AppStatus, [string, string | null]>> = {
    SUBMITTED: ['Заявка № {n} отправлена', 'Начали проверку. Обычно это занимает несколько минут.'],
    NEED_INFO: ['Нужна информация по заявке № {n}', 'Ответьте на запрос банка в карточке заявки.'],
    MANUAL_REVIEW: ['Заявку № {n} рассматривает специалист', 'Ответим в течение рабочего дня.'],
    OFFER: ['Предложение по заявке № {n} готово', 'Посмотрите условия и примите решение.'],
    REJECTED: ['Решение по заявке № {n}', 'К сожалению, банк отказал. Причина — в карточке заявки.'],
    SIGNING: ['Документы по заявке № {n} готовы', 'Проверьте и подпишите договор в кабинете.'],
    ISSUED: ['Кредит по заявке № {n} выдан', 'Деньги поступили на счёт. График платежей — в кабинете.'],
    EXPIRED: ['Срок по заявке № {n} истёк', 'Можно подать новую заявку.'],
};

const BANK_NOTICES: Partial<Record<AppStatus, string>> = {
    MANUAL_REVIEW: 'Заявка № {n} ждёт рассмотрения',
    CANCELLED: 'Клиент отозвал заявку № {n}',
    ACCEPTED: 'Клиент принял предложение по заявке № {n}',
    DECLINED: 'Клиент отказался от предложения по заявке № {n}',
};

export function enqueue(
    state: DemoState,
    kind: JobKind,
    app: AppRow,
    now: number,
    step: StepCode | null = null,
    delay = pickupDelay(),
): void {
    state.seq.job += 1;
    state.jobs.push({
        id: state.seq.job,
        kind,
        app_id: app.id,
        run_no: step ? app.run_no : null,
        step,
        status: 'QUEUED',
        run_at: now + delay,
        attempts: 0,
        last_error: null,
        outcome: null,
    });
}

// Сколько записей хранить: лента уведомлений показывает 50 последних, журнал — 200
const KEEP_NOTICES = 300;
const KEEP_SIGNALS = 300;
const KEEP_AUDIT = 400;

/** Снять задания заявки. Шаг, который выполнялся, снова «ожидает» — как после отката транзакции на сервере. */
export function cancelJobs(state: DemoState, appId: string): void {
    for (const job of state.jobs.filter((j) => j.app_id === appId && j.status === 'RUNNING' && j.step)) {
        const row = state.steps.find((s) => s.app_id === appId && s.run_no === job.run_no && s.step === job.step);
        if (row?.status === 'RUNNING') {
            row.status = 'PENDING';
            row.started_at = null;
        }
    }
    state.jobs = state.jobs.filter((job) => job.app_id !== appId);
}

/** Старые события не нужны ни ленте, ни потоку: хранилище браузера не должно расти без конца. */
function trimEvents(state: DemoState): void {
    if (state.events.length <= KEEP_NOTICES + KEEP_SIGNALS) return;
    const notices = state.events.filter((e) => e.notify).slice(-KEEP_NOTICES);
    const signals = state.events.filter((e) => !e.notify).slice(-KEEP_SIGNALS);
    state.events = [...notices, ...signals].sort((a, b) => a.id - b.id);
}

export function emit(
    state: DemoState,
    app: AppRow | null,
    now: number,
    event: {
        audience: Audience;
        kind: string;
        title: string;
        body?: string | null;
        notify?: boolean;
        /** адресат-компания события без заявки (ответ поддержки клиенту) */
        company_id?: string | null;
    },
): void {
    state.seq.event += 1;
    state.events.push({
        id: state.seq.event,
        app_id: app?.id ?? null,
        company_id: app?.company_id ?? event.company_id ?? null,
        audience: event.audience,
        kind: event.kind,
        title: event.title,
        body: event.body ?? null,
        notify: event.notify ?? true,
        created_at: iso(now),
    });
    trimEvents(state);
}

/** Сигнал интерфейсам обновить данные заявки без уведомления в ленте. */
export const refresh = (state: DemoState, app: AppRow, now: number, kind = 'UPDATED'): void =>
    emit(state, app, now, { audience: 'ALL', kind, title: kind, notify: false });

export function audit(
    state: DemoState,
    now: number,
    entry: {
        actor: string;
        user: DemoUser | null;
        action: string;
        entity_type: string;
        entity_id: string;
        details?: Json;
    },
): void {
    state.seq.audit += 1;
    state.audit.push({
        id: state.seq.audit,
        actor: entry.actor,
        actor_user_id: entry.user?.id ?? null,
        action: entry.action,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        details: entry.details ?? {},
        created_at: iso(now),
    });
    if (state.audit.length > KEEP_AUDIT) state.audit = state.audit.slice(-KEEP_AUDIT);
}

/** Новый прогон конвейера: шаги в статусе «ожидает», первое задание в очередь. */
export function startPipeline(state: DemoState, app: AppRow, now: number): void {
    app.run_no += 1;
    for (const step of PIPELINE_ORDER) {
        state.steps.push({
            app_id: app.id,
            run_no: app.run_no,
            step,
            status: 'PENDING',
            attempts: 0,
            started_at: null,
            finished_at: null,
            next_retry_at: null,
            waiting_since: null,
            error: null,
            result: null,
        });
    }
    enqueue(state, 'PIPELINE_STEP', app, now, PIPELINE_ORDER[0]);
}

export function transition(
    state: DemoState,
    app: AppRow,
    target: AppStatus,
    now: number,
    { actor, user = null, reason = null }: { actor: Actor; user?: DemoUser | null; reason?: string | null },
): void {
    const current = app.status;
    if (!canTransition(current, target, actor)) {
        throw new HttpError(409, `Действие недоступно: заявка в статусе «${META.statuses[current].client}»`);
    }
    const at = iso(now);
    app.status = target;
    app.status_changed_at = at;
    if (target === 'SUBMITTED') app.submitted_at = at;
    if (target === 'MANUAL_REVIEW') app.sla_due_at = iso(now + REVIEW_SLA_HOURS * HOUR);
    if (FINAL_STATUSES.has(target)) app.closed_at = at;

    state.seq.history += 1;
    state.history.push({
        id: state.seq.history,
        app_id: app.id,
        from_status: current,
        to_status: target,
        actor,
        actor_user_id: user?.id ?? null,
        reason,
        created_at: at,
    });
    audit(state, now, {
        actor,
        user,
        action: 'STATUS_CHANGED',
        entity_type: 'application',
        entity_id: app.id,
        details: { from: current, to: target, reason },
    });

    const n = app.number;
    emit(state, app, now, {
        audience: 'ALL',
        kind: 'STATUS_CHANGED',
        title: META.statuses[target].client,
        notify: false,
    });
    const client = CLIENT_NOTICES[target];
    if (client) {
        emit(state, app, now, {
            audience: 'CLIENT',
            kind: `STATUS_${target}`,
            title: client[0].replace('{n}', n),
            body: client[1],
        });
    }
    const bank = BANK_NOTICES[target];
    if (bank)
        emit(state, app, now, {
            audience: 'BANK',
            kind: `STATUS_${target}`,
            title: bank.replace('{n}', n),
            body: reason,
        });

    // Задания обработчику — как transactional outbox на сервере
    if (
        target === 'SUBMITTED' ||
        ((current === 'NEED_INFO' || current === 'MANUAL_REVIEW') && target === 'IN_PROCESSING')
    ) {
        startPipeline(state, app, now);
    } else if (target === 'ACCEPTED') {
        enqueue(state, 'GENERATE_DOCS', app, now);
    } else if (target === 'SIGNED') {
        enqueue(state, 'DISBURSE', app, now);
    }
    if (FINAL_STATUSES.has(target)) cancelJobs(state, app.id);
}
