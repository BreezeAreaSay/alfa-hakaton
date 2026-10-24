const TOKEN_KEY = 'credit-cabinet-token';

/**
 * Демо-режим для GitHub Pages (сборка с VITE_DEMO=1): запросы к API обслуживает имитация сервера в браузере,
 * данные хранятся в localStorage. В обычной сборке код имитации не загружается.
 */
export const DEMO_MODE = import.meta.env.VITE_DEMO === '1';

/** Единая точка обращения к серверу: обычный fetch или имитация сервера в демо-режиме. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (DEMO_MODE) {
        const { demoFetch } = await import('../demo/server');
        return demoFetch(path, init);
    }
    return fetch(path, init);
}

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

export function getToken(): string | null {
    try {
        return localStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
}

export function setToken(token: string | null): void {
    try {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
    } catch {
        // хранилище недоступно (приватный режим) — токен живёт до перезагрузки
    }
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
    onUnauthorized = handler;
}

function errorMessage(body: unknown, status: number): string {
    if (body && typeof body === 'object' && 'detail' in body) {
        const detail = (body as { detail: unknown }).detail;
        if (typeof detail === 'string') return detail;
        if (Array.isArray(detail)) {
            return detail.map((d) => (typeof d === 'object' && d && 'msg' in d ? String(d.msg) : String(d))).join('; ');
        }
    }
    return status >= 500 ? 'Сервис временно недоступен. Попробуйте ещё раз' : 'Не удалось выполнить действие';
}

export async function api<T>(
    path: string,
    options: { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {},
): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (options.form) body = options.form;
    else if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
    }
    const response = await apiFetch(path, { method: options.method ?? 'GET', headers, body });
    if (response.status === 401 && token) onUnauthorized?.();
    if (!response.ok) {
        let data: unknown = null;
        try {
            data = await response.json();
        } catch {
            // ответ без тела
        }
        throw new ApiError(response.status, errorMessage(data, response.status));
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
}

export function newIdempotencyKey(): string {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Файл с сервера по токену. При ошибке — текст ответа, как в api(), иначе запасное сообщение. */
async function fetchBlob(path: string, fallback: string): Promise<Blob> {
    const token = getToken();
    const response = await apiFetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
        let data: unknown = null;
        try {
            data = await response.json();
        } catch {
            // ответ без тела
        }
        throw new ApiError(response.status, data ? errorMessage(data, response.status) : fallback);
    }
    return response.blob();
}

export async function download(path: string, fileName: string): Promise<void> {
    const blob = await fetchBlob(path, 'Не удалось скачать файл');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function openInNewTab(path: string): Promise<void> {
    const blob = await fetchBlob(path, 'Не удалось открыть файл');
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
}
