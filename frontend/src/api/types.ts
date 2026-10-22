// Типы ответов API (см. backend/app/schemas.py и /api/docs). Денежные суммы приходят строками (Decimal).

export type Role = 'CLIENT' | 'UNDERWRITER' | 'ADMIN';

export type AppStatus =
    | 'DRAFT'
    | 'SUBMITTED'
    | 'IN_PROCESSING'
    | 'NEED_INFO'
    | 'MANUAL_REVIEW'
    | 'OFFER'
    | 'ACCEPTED'
    | 'SIGNING'
    | 'SIGNED'
    | 'ISSUED'
    | 'REJECTED'
    | 'DECLINED'
    | 'CANCELLED'
    | 'EXPIRED';

export type Purpose = 'WORKING_CAPITAL' | 'CASH_GAP' | 'EQUIPMENT' | 'EXPANSION';

export type Money = string | number;

export interface Company {
    id: string;
    inn: string;
    name: string;
    legal_form: 'OOO' | 'IP' | null;
    ogrn: string | null;
    registration_date: string | null;
    okved: string | null;
    okved_name: string | null;
    address: string | null;
    status: string | null;
    status_label: string | null;
    director_name: string | null;
    is_bank_client: boolean;
    bank_account_opened_at: string | null;
    business_months: number | null;
    account_months: number | null;
    registry_synced_at: string | null;
}

export interface User {
    id: string;
    login: string;
    full_name: string;
    position: string | null;
    role: Role;
    can_sign: boolean;
    company: Company | null;
}

export interface Product {
    code: string;
    name: string;
    kind: 'LOAN' | 'OVERDRAFT' | 'CREDIT_LINE';
    description: string;
    min_amount: Money;
    max_amount: Money;
    min_term: number;
    max_term: number;
    base_rate: Money;
    collateral_required: boolean;
    min_business_months: number;
    max_business_months: number | null;
    requires_bank_account_months: number | null;
    auto_limit: Money | null;
}

export interface QuoteItem {
    product: Product;
    eligible: boolean;
    issues: string[];
    rate_from: Money;
    monthly_payment: Money;
    overpayment: Money;
    payment_label: string;
}

export interface Step {
    step: string;
    title: string;
    status: 'PENDING' | 'RUNNING' | 'DONE' | 'SKIPPED' | 'WAITING' | 'FAILED';
    attempts: number;
    started_at: string | null;
    finished_at: string | null;
    next_retry_at: string | null;
    waiting_text: string | null;
    error: string | null;
}

export interface Offer {
    id: string;
    option_no: number;
    kind: 'AS_REQUESTED' | 'COUNTER';
    product_code: string;
    product_name: string;
    product_kind: string;
    amount: Money;
    term_months: number;
    rate: Money;
    monthly_payment: Money;
    overpayment: Money;
    payment_label: string;
    valid_until: string;
    status: 'ACTIVE' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'VOID';
    note: string | null;
}

export interface InfoItem {
    code: string;
    title: string;
    hint?: string;
}

export interface InfoRequest {
    id: string;
    origin: 'SYSTEM' | 'UNDERWRITER';
    items: InfoItem[];
    comment: string | null;
    due_at: string;
    status: 'OPEN' | 'ANSWERED' | 'EXPIRED' | 'CANCELLED';
    answer_text: string | null;
    answered_at: string | null;
    created_at: string;
}

export interface StatementSummary {
    source: string;
    account: string | null;
    period_from: string;
    period_to: string;
    operations: number;
    months: { month: string; inflow: number; outflow: number }[];
    total_inflow: number;
    avg_monthly_inflow: number;
}

export interface DocumentItem {
    id: string;
    kind: string;
    kind_label: string;
    source: 'CLIENT' | 'BANK' | 'GENERATED';
    file_name: string;
    content_type: string;
    size: number;
    sha256: string;
    created_at: string;
    info_request_id: string | null;
    parsed: StatementSummary | null;
    signed_by_client: boolean;
    signed_by_bank: boolean;
}

export interface HistoryItem {
    from_status: AppStatus | null;
    to_status: AppStatus;
    to_label: string;
    actor: 'CLIENT' | 'SYSTEM' | 'UNDERWRITER' | 'ADMIN';
    actor_name: string | null;
    reason: string | null;
    created_at: string;
}

export interface Explanation {
    positive: string[];
    negative: string[];
    limit_phrase: string | null;
    rejection: string[];
    advice: string[];
}

export interface ScheduleItem {
    n: number;
    due_date: string;
    payment: Money;
    principal: Money;
    interest: Money;
    balance: Money;
}

export interface Loan {
    id: string;
    product_code: string;
    account_number: string;
    amount: Money;
    rate: Money;
    term_months: number;
    monthly_payment: Money;
    issued_at: string;
    schedule: ScheduleItem[];
}

export interface Application {
    id: string;
    number: string;
    status: AppStatus;
    status_label: string;
    next_step: string;
    needs_action: boolean;
    can_cancel: boolean;
    product: Product;
    purpose: Purpose;
    purpose_label: string;
    purpose_text: string | null;
    amount: Money;
    term_months: number;
    declared_revenue: Money | null;
    collateral_type: string | null;
    collateral_value: Money | null;
    created_at: string;
    submitted_at: string | null;
    status_changed_at: string;
    closed_at: string | null;
    run_no: number;
    company: Company;
    steps: Step[];
    offers: Offer[];
    info_requests: InfoRequest[];
    documents: DocumentItem[];
    history: HistoryItem[];
    explanation: Explanation;
    loan: Loan | null;
    ai_parsed: Record<string, unknown> | null;
}

export interface ApplicationListItem {
    id: string;
    number: string;
    status: AppStatus;
    status_label: string;
    product_code: string;
    product_name: string;
    amount: Money;
    term_months: number;
    created_at: string;
    status_changed_at: string;
    needs_action: boolean;
}

export interface ChatMessage {
    id: number;
    author_name: string;
    author_role: Role;
    text: string;
    created_at: string;
}

export interface NotificationItem {
    id: number;
    application_id: string | null;
    kind: string;
    title: string;
    body: string | null;
    created_at: string;
    unread: boolean;
}

export interface Notifications {
    unread: number;
    items: NotificationItem[];
}

export interface Meta {
    statuses: Record<AppStatus, { client: string; bank: string; next: string }>;
    steps: Record<string, { title: string; waiting: string }>;
    purposes: Record<Purpose, string>;
    documents: Record<string, string>;
    company_statuses: Record<string, string>;
    info_items: InfoItem[];
    reasons: Record<string, { bank: string; client: string }>;
    flags: Record<string, string>;
    stop_factors: Record<string, string>;
    limit_phrases: Record<string, string>;
}

// ---------------------------------------------------------------- банк

export interface QueueItem {
    id: string;
    number: string;
    company_name: string;
    inn: string;
    legal_form: string | null;
    product_code: string;
    product_name: string;
    amount: Money;
    term_months: number;
    status: AppStatus;
    status_label: string;
    risk_class: string | null;
    score: number | null;
    flags: string[];
    assignee_name: string | null;
    assignee_is_me: boolean;
    sla_due_at: string | null;
    overdue: boolean;
    submitted_at: string | null;
    status_changed_at: string;
    waiting_source: string | null;
}

export interface BankSummary {
    manual_review: number;
    mine: number;
    overdue: number;
    need_info: number;
    in_processing: number;
    waiting_sources: number;
    offers: number;
    issued_today: number;
}

export interface Factor {
    code: string;
    title: string;
    value: string;
    points: number;
    phrase: string | null;
}

export interface DecisionView {
    id: number;
    kind: 'AUTO' | 'MANUAL';
    outcome: string;
    policy_version: string;
    limit: number | null;
    limit_binding: string | null;
    rate: number | null;
    flags: { code: string; title: string }[];
    stop_factors: { code: string; title: string }[];
    reason_codes: string[];
    trace: { rule: string; result: string; detail: string }[];
    comment: string | null;
    decided_by: string | null;
    created_at: string;
}

export interface SourceResult {
    status: Step['status'];
    result: Record<string, any> | null;
    error: string | null;
    attempts: number;
    finished_at: string | null;
}

export interface Dossier {
    application: Application;
    sources: Record<string, SourceResult>;
    scoring: {
        score: number;
        risk_class: string;
        pd: number;
        version: string;
        factors: Factor[];
        features: Record<string, any>;
    } | null;
    auto_decision: DecisionView | null;
    last_decision: DecisionView | null;
    limit: {
        limit: number | null;
        binding: string | null;
        phrase: string | null;
        constraints: { code: string; amount: number; max_payment?: number }[];
        rate: number;
    } | null;
    assignee: string | null;
    assignee_is_me: boolean;
    sla_due_at: string | null;
    audit: { action: string; actor: string; user: string | null; details: Record<string, any>; created_at: string }[];
    info_item_presets: InfoItem[];
}

export interface TermsPreview {
    limit: Money | null;
    limit_binding: string | null;
    limit_phrase: string | null;
    min_rate: Money | null;
    rate: Money | null;
    monthly_payment: Money | null;
    overpayment: Money | null;
    payment_label: string;
    errors: string[];
    constraints: { code: string; amount: number; max_payment?: number }[];
}

export interface PipelineIssue {
    application_id: string | null;
    number: string | null;
    company_name: string | null;
    status: AppStatus | null;
    step: string;
    step_title: string;
    step_status: string;
    attempts: number;
    error: string | null;
    waiting_since: string | null;
    next_retry_at: string | null;
}

export interface Fault {
    source: string;
    title: string;
    mode: 'ok' | 'error' | 'timeout' | 'slow';
    latency_ms: number;
}

export interface AuditRow {
    id: number;
    action: string;
    actor: string;
    user: string | null;
    entity_type: string;
    entity_id: string;
    details: Record<string, any>;
    created_at: string;
}

export interface AiStatus {
    enabled: boolean;
    model: string | null;
    mode: string;
}

/** Сводка досье от модели: «+ » — сильная сторона, «− » — риск. */
export interface AiSummary {
    points: string[];
    model: string | null;
}

export interface ParsedNeed {
    purpose: Purpose | null;
    amount: number | null;
    term_months: number | null;
    summary: string | null;
    source: 'llm' | 'rules';
}
