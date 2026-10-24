// Данные имитации сервера: те же сущности, что в базе настоящего бэкенда (backend/app/models.py).
// Суммы хранятся числами в рублях, время — строками ISO 8601 в UTC.
import type { AppStatus, Fault, InfoItem, Purpose, Role, StatementSummary, Step } from '../api/types';
import type { CustomCompanyRecord } from './engine/company-builder';
import type { Factor } from './engine/scoring';
import type { Json } from './engine/features';
import type { TraceRow } from './engine/policy';

export type Actor = 'CLIENT' | 'SYSTEM' | 'UNDERWRITER' | 'ADMIN';
export type Audience = 'CLIENT' | 'BANK' | 'ALL';
export type StepCode = 'DATA_CHECK' | 'EGRUL' | 'FNS' | 'GIRBO' | 'BKI' | 'BANK' | 'SCORING' | 'POLICY';
export type FaultMode = Fault['mode'];

export const PIPELINE_ORDER: StepCode[] = ['DATA_CHECK', 'EGRUL', 'FNS', 'GIRBO', 'BKI', 'BANK', 'SCORING', 'POLICY'];
export const EXTERNAL_STEPS = new Set<StepCode>(['EGRUL', 'FNS', 'GIRBO', 'BKI', 'BANK']);
export const FINAL_STATUSES = new Set<AppStatus>(['ISSUED', 'REJECTED', 'DECLINED', 'CANCELLED', 'EXPIRED']);
export const CANCELLABLE = new Set<AppStatus>([
    'SUBMITTED',
    'IN_PROCESSING',
    'NEED_INFO',
    'MANUAL_REVIEW',
    'OFFER',
    'ACCEPTED',
    'SIGNING',
]);

export interface DemoUser {
    id: string;
    login: string;
    full_name: string;
    position: string | null;
    role: Role;
    can_sign: boolean;
    company_id: string | null;
}

export interface AppRow {
    id: string;
    number: string;
    company_id: string;
    created_by: string;
    product_code: string;
    purpose: Purpose;
    purpose_text: string | null;
    amount: number;
    term_months: number;
    declared_revenue: number | null;
    collateral_type: string | null;
    collateral_value: number | null;
    status: AppStatus;
    created_at: string;
    submitted_at: string | null;
    status_changed_at: string;
    closed_at: string | null;
    sla_due_at: string | null;
    assignee_id: string | null;
    run_no: number;
    consents: boolean;
    ai_parsed: Json | null;
}

export interface StepRow {
    app_id: string;
    run_no: number;
    step: StepCode;
    status: Step['status'];
    attempts: number;
    started_at: string | null;
    finished_at: string | null;
    next_retry_at: string | null;
    waiting_since: string | null;
    error: string | null;
    result: Json | null;
}

export interface ScoringRow {
    id: number;
    app_id: string;
    run_no: number;
    score: number;
    risk_class: string;
    pd: number;
    version: string;
    features: Json;
    factors: Factor[];
    created_at: string;
}

export interface DecisionRow {
    id: number;
    app_id: string;
    run_no: number;
    kind: 'AUTO' | 'MANUAL';
    outcome: string;
    policy_version: string;
    limit: number | null;
    limit_binding: string | null;
    product_code: string;
    rate: number | null;
    stop_factors: string[];
    flags: string[];
    reason_codes: string[];
    trace: TraceRow[];
    comment: string | null;
    decided_by: string | null;
    created_at: string;
}

export interface OfferRow {
    id: string;
    app_id: string;
    decision_id: number;
    option_no: number;
    kind: 'AS_REQUESTED' | 'COUNTER';
    product_code: string;
    amount: number;
    term_months: number;
    rate: number;
    monthly_payment: number;
    overpayment: number;
    valid_until: string;
    status: 'ACTIVE' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'VOID';
    note: string | null;
    created_at: string;
}

export interface InfoRequestRow {
    id: string;
    app_id: string;
    origin: 'SYSTEM' | 'UNDERWRITER';
    requested_by: string | null;
    items: InfoItem[];
    comment: string | null;
    due_at: string;
    status: 'OPEN' | 'ANSWERED' | 'EXPIRED' | 'CANCELLED';
    answer_text: string | null;
    answered_at: string | null;
    created_at: string;
}

export interface DocumentRow {
    id: string;
    app_id: string;
    kind: string;
    source: 'CLIENT' | 'BANK' | 'GENERATED';
    file_name: string;
    content_type: string;
    size: number;
    sha256: string;
    created_at: string;
    info_request_id: string | null;
    parsed: StatementSummary | null;
    uploaded_by: string | null;
}

export interface SignatureRow {
    app_id: string;
    document_id: string;
    signer_role: 'CLIENT' | 'BANK';
    signer_user_id: string | null;
    created_at: string;
}

export interface LoanRow {
    id: string;
    app_id: string;
    offer_id: string;
    product_code: string;
    account_number: string;
    amount: number;
    rate: number;
    term_months: number;
    monthly_payment: number;
    issued_at: string;
}

export interface HistoryRow {
    id: number;
    app_id: string;
    from_status: AppStatus | null;
    to_status: AppStatus;
    actor: Actor;
    actor_user_id: string | null;
    reason: string | null;
    created_at: string;
}

export interface MessageRow {
    id: number;
    app_id: string;
    author_id: string;
    author_role: Role;
    text: string;
    created_at: string;
}

export interface EventRow {
    id: number;
    app_id: string | null;
    company_id: string | null;
    audience: Audience;
    kind: string;
    title: string;
    body: string | null;
    notify: boolean;
    created_at: string;
}

export interface AuditEntry {
    id: number;
    actor: string;
    actor_user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    details: Json;
    created_at: string;
}

export type JobKind = 'PIPELINE_STEP' | 'GENERATE_DOCS' | 'DISBURSE';

/**
 * Задание обработчику конвейера. QUEUED ждёт run_at; RUNNING — идёт работа (вызов внешней системы),
 * результат которой известен заранее и применяется в run_at.
 */
export interface JobRow {
    id: number;
    kind: JobKind;
    app_id: string;
    run_no: number | null;
    step: StepCode | null;
    status: 'QUEUED' | 'RUNNING';
    run_at: number;
    attempts: number;
    last_error: string | null;
    outcome: { ok: boolean; error: string | null } | null;
}

export interface DemoState {
    version: number;
    fixtures: string;
    created_at: string;
    seq: {
        app: number;
        event: number;
        audit: number;
        message: number;
        decision: number;
        scoring: number;
        history: number;
        job: number;
    };
    faults: Record<string, { mode: FaultMode; latency_ms: number }>;
    last_read: Record<string, number>;
    synced_at: Record<string, string>;
    applications: AppRow[];
    steps: StepRow[];
    scorings: ScoringRow[];
    decisions: DecisionRow[];
    offers: OfferRow[];
    info_requests: InfoRequestRow[];
    documents: DocumentRow[];
    signatures: SignatureRow[];
    loans: LoanRow[];
    history: HistoryRow[];
    messages: MessageRow[];
    events: EventRow[];
    audit: AuditEntry[];
    jobs: JobRow[];
    idempotency: string[];
    /** Компании из конструктора администратора: профиль, снимки источников и пользователь — рядом с остальными. */
    custom_companies: CustomCompanyRecord[];
}

export const iso = (ms: number): string => new Date(ms).toISOString();

const HEX = '0123456789abcdef';

export function uuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // запасной вариант для страниц без защищённого контекста (http по IP-адресу)
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => HEX[b >> 4] + HEX[b & 15]).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
