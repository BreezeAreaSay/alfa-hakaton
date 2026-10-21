import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api, newIdempotencyKey } from './client';
import { subscribe } from './stream';
import type {
    AiStatus,
    Application,
    ApplicationListItem,
    AuditRow,
    BankSummary,
    ChatMessage,
    Company,
    DocumentItem,
    Dossier,
    Fault,
    Meta,
    Notifications,
    ParsedNeed,
    PipelineIssue,
    Product,
    Purpose,
    QueueItem,
    QuoteItem,
    TermsPreview,
} from './types';

export const keys = {
    meta: ['meta'] as const,
    company: ['company'] as const,
    products: ['products'] as const,
    applications: ['applications'] as const,
    application: (id: string) => ['application', id] as const,
    messages: (id: string) => ['messages', id] as const,
    notifications: ['notifications'] as const,
    bank: ['bank'] as const,
    dossier: (id: string) => ['bank', 'dossier', id] as const,
    ai: ['ai'] as const,
};

export const useMeta = () =>
    useQuery({ queryKey: keys.meta, queryFn: () => api<Meta>('/api/meta'), staleTime: Infinity });

export const useCompany = () => useQuery({ queryKey: keys.company, queryFn: () => api<Company>('/api/company') });

export const useProducts = () =>
    useQuery({ queryKey: keys.products, queryFn: () => api<Product[]>('/api/products'), staleTime: Infinity });

export interface QuoteParams {
    purpose: Purpose;
    amount: number;
    term_months: number;
    legal_form?: string | null;
    business_months?: number | null;
    is_bank_client?: boolean;
    account_months?: number | null;
}

export const useQuote = (params: QuoteParams | null) =>
    useQuery({
        queryKey: ['quote', params],
        queryFn: () => api<QuoteItem[]>('/api/calculator/quote', { method: 'POST', body: params }),
        enabled: params !== null,
        placeholderData: (previous) => previous,
    });

export const useApplications = () =>
    useQuery({ queryKey: keys.applications, queryFn: () => api<ApplicationListItem[]>('/api/applications') });

export const useApplication = (id: string | undefined) =>
    useQuery({
        queryKey: keys.application(id ?? ''),
        queryFn: () => api<Application>(`/api/applications/${id}`),
        enabled: Boolean(id),
    });

export const useMessages = (id: string, enabled = true) =>
    useQuery({
        queryKey: keys.messages(id),
        queryFn: () => api<ChatMessage[]>(`/api/applications/${id}/messages`),
        enabled,
    });

export const useNotifications = () =>
    useQuery({ queryKey: keys.notifications, queryFn: () => api<Notifications>('/api/notifications') });

export const useAiStatus = () =>
    useQuery({ queryKey: keys.ai, queryFn: () => api<AiStatus>('/api/ai/status'), staleTime: 60_000 });

/** Общий хелпер: мутация, после которой обновляем всё, что связано с заявкой. */
function useAppMutation<TVars, TResult = Application>(fn: (vars: TVars) => Promise<TResult>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: fn,
        onSuccess: (result) => {
            if (result && typeof result === 'object' && 'id' in result && 'status' in result) {
                client.setQueryData(keys.application((result as unknown as Application).id), result);
            }
            void client.invalidateQueries({ queryKey: keys.applications });
            void client.invalidateQueries({ queryKey: ['application'] });
            void client.invalidateQueries({ queryKey: keys.bank });
        },
    });
}

export interface DraftInput {
    product_code: string;
    purpose: Purpose;
    purpose_text?: string | null;
    amount: number;
    term_months: number;
    declared_revenue?: number | null;
    collateral_type?: string | null;
    collateral_value?: number | null;
    ai_parsed?: Record<string, unknown> | null;
}

export const useCreateDraft = () =>
    useAppMutation((body: DraftInput) => api<Application>('/api/applications', { method: 'POST', body }));

export const useUpdateDraft = () =>
    useAppMutation(({ id, ...body }: Partial<DraftInput> & { id: string }) =>
        api<Application>(`/api/applications/${id}`, { method: 'PATCH', body }),
    );

export const useDeleteDraft = () =>
    useAppMutation((id: string) => api<void>(`/api/applications/${id}`, { method: 'DELETE' }));

export const useSubmit = () =>
    useAppMutation(({ id, key }: { id: string; key: string }) =>
        api<Application>(`/api/applications/${id}/submit`, {
            method: 'POST',
            body: { consent_bki: true, consent_pd: true },
            headers: { 'Idempotency-Key': key },
        }),
    );

export const useCancel = () =>
    useAppMutation((id: string) => api<Application>(`/api/applications/${id}/cancel`, { method: 'POST' }));

export const useUpload = () => {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({
            id,
            file,
            kind,
            infoRequestId,
        }: {
            id: string;
            file: File;
            kind: string;
            infoRequestId?: string;
        }) => {
            const form = new FormData();
            form.append('file', file);
            form.append('kind', kind);
            if (infoRequestId) form.append('info_request_id', infoRequestId);
            return api<DocumentItem>(`/api/applications/${id}/documents`, { method: 'POST', form });
        },
        onSuccess: (_, vars) => {
            void client.invalidateQueries({ queryKey: keys.application(vars.id) });
            void client.invalidateQueries({ queryKey: keys.dossier(vars.id) });
        },
    });
};

export const useDeleteDocument = () => {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api<void>(`/api/documents/${id}`, { method: 'DELETE' }),
        onSuccess: () => void client.invalidateQueries({ queryKey: ['application'] }),
    });
};

export const useAnswer = () =>
    useAppMutation(({ requestId, text }: { requestId: string; text: string | null }) =>
        api<Application>(`/api/info-requests/${requestId}/answer`, { method: 'POST', body: { text } }),
    );

export const useAcceptOffer = () =>
    useAppMutation((offerId: string) => api<Application>(`/api/offers/${offerId}/accept`, { method: 'POST' }));

export const useDecline = () =>
    useAppMutation((id: string) => api<Application>(`/api/applications/${id}/decline`, { method: 'POST' }));

export const useSign = () =>
    useAppMutation(({ id, password }: { id: string; password: string }) =>
        api<Application>(`/api/applications/${id}/sign`, {
            method: 'POST',
            body: { password },
            headers: { 'Idempotency-Key': newIdempotencyKey() },
        }),
    );

export const useSendMessage = (id: string) => {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (text: string) =>
            api<ChatMessage>(`/api/applications/${id}/messages`, { method: 'POST', body: { text } }),
        onSuccess: () => void client.invalidateQueries({ queryKey: keys.messages(id) }),
    });
};

export const useMarkRead = () => {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => api<void>('/api/notifications/read', { method: 'POST' }),
        onSuccess: () => void client.invalidateQueries({ queryKey: keys.notifications }),
    });
};

export const useParseNeed = () =>
    useMutation({
        mutationFn: (text: string) => api<ParsedNeed>('/api/ai/parse-need', { method: 'POST', body: { text } }),
    });

// ---------------------------------------------------------------- банк

export interface QueueFilters {
    status?: string[];
    product?: string;
    risk_class?: string;
    mine?: boolean;
    q?: string;
    include_closed?: boolean;
}

function queueQuery(filters: QueueFilters): string {
    const params = new URLSearchParams();
    filters.status?.forEach((s) => params.append('status', s));
    if (filters.product) params.set('product', filters.product);
    if (filters.risk_class) params.set('risk_class', filters.risk_class);
    if (filters.mine) params.set('mine', 'true');
    if (filters.q) params.set('q', filters.q);
    if (filters.include_closed) params.set('include_closed', 'true');
    const query = params.toString();
    return query ? `?${query}` : '';
}

export const useBankSummary = () =>
    useQuery({ queryKey: ['bank', 'summary'], queryFn: () => api<BankSummary>('/api/bank/summary') });

export const useQueue = (filters: QueueFilters) =>
    useQuery({
        queryKey: ['bank', 'queue', filters],
        queryFn: () => api<QueueItem[]>(`/api/bank/applications${queueQuery(filters)}`),
        placeholderData: (previous) => previous,
    });

export const useDossier = (id: string | undefined) =>
    useQuery({
        queryKey: keys.dossier(id ?? ''),
        queryFn: () => api<Dossier>(`/api/bank/applications/${id}/dossier`),
        enabled: Boolean(id),
    });

export const usePipelineIssues = () =>
    useQuery({ queryKey: ['bank', 'issues'], queryFn: () => api<PipelineIssue[]>('/api/bank/pipeline/issues') });

export const useFaults = () =>
    useQuery({ queryKey: ['bank', 'faults'], queryFn: () => api<Fault[]>('/api/admin/simulator/faults') });

export const useAudit = () =>
    useQuery({ queryKey: ['bank', 'audit'], queryFn: () => api<AuditRow[]>('/api/admin/audit') });

export const useAssign = () =>
    useAppMutation((id: string) => api<Application>(`/api/bank/applications/${id}/assign`, { method: 'POST' }));

export interface DecisionInput {
    id: string;
    action: 'APPROVE' | 'COUNTER' | 'REJECT';
    product_code?: string;
    amount?: number;
    term_months?: number;
    rate?: number;
    reason_code?: string;
    comment?: string;
}

export const useDecision = () =>
    useAppMutation(({ id, ...body }: DecisionInput) =>
        api<Application>(`/api/bank/applications/${id}/decision`, { method: 'POST', body }),
    );

export const useRequestInfo = () =>
    useAppMutation(
        ({ id, items, comment, due_hours }: { id: string; items: string[]; comment: string; due_hours: number }) =>
            api<Application>(`/api/bank/applications/${id}/info-requests`, {
                method: 'POST',
                body: { items, comment, due_hours },
            }),
    );

export const useRestart = () =>
    useAppMutation((id: string) => api<Application>(`/api/bank/applications/${id}/restart`, { method: 'POST' }));

export const useRetryNow = () =>
    useAppMutation((id: string) => api<Application>(`/api/bank/applications/${id}/pipeline/retry`, { method: 'POST' }));

export const useTermsPreview = (
    id: string,
    params: { product_code: string; amount: number; term_months: number; rate?: number } | null,
) =>
    useQuery({
        queryKey: ['bank', 'preview', id, params],
        queryFn: () =>
            api<TermsPreview>(`/api/bank/applications/${id}/terms-preview`, { method: 'POST', body: params }),
        enabled: params !== null && params.amount > 0 && params.term_months > 0,
        placeholderData: (previous) => previous,
    });

export const useSetFault = () => {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ source, mode }: { source: string; mode: Fault['mode'] }) =>
            api<Fault[]>(`/api/admin/simulator/faults/${source}`, {
                method: 'PUT',
                body: { mode, latency_ms: mode === 'slow' ? 4000 : 0 },
            }),
        onSuccess: (data) => client.setQueryData(['bank', 'faults'], data),
    });
};

export const useResetDemo = () => {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => api<{ preseeded: number }>('/api/admin/demo/reset', { method: 'POST' }),
        onSuccess: () => void client.invalidateQueries(),
    });
};

/** Подписка на поток событий: обновляет данные на экране без перезагрузки. */
export function useLiveUpdates(enabled: boolean): void {
    const client = useQueryClient();
    useEffect(() => {
        if (!enabled) return undefined;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const pending = new Set<string>();
        const flush = () => {
            timer = null;
            void client.invalidateQueries({ queryKey: keys.notifications });
            void client.invalidateQueries({ queryKey: keys.applications });
            void client.invalidateQueries({ queryKey: ['bank', 'summary'] });
            void client.invalidateQueries({ queryKey: ['bank', 'queue'] });
            void client.invalidateQueries({ queryKey: ['bank', 'issues'] });
            void client.invalidateQueries({ queryKey: ['bank', 'faults'] });
            void client.invalidateQueries({ queryKey: ['bank', 'audit'] });
            pending.forEach((id) => {
                void client.invalidateQueries({ queryKey: keys.application(id) });
                void client.invalidateQueries({ queryKey: keys.messages(id) });
                void client.invalidateQueries({ queryKey: keys.dossier(id) });
            });
            pending.clear();
        };
        return subscribe((event) => {
            if (event.application_id) pending.add(event.application_id);
            if (!timer) timer = setTimeout(flush, 250);
        });
    }, [client, enabled]);
}
