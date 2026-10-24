// Имитация сервера для демо-режима (сборка с VITE_DEMO=1, GitHub Pages): обрабатывает запросы к API
// в браузере и отвечает настоящими объектами Response, как fetch. Данные — в localStorage (store.ts).
import { HttpError, errorResponse, json } from './http';
import { type Ctx, ROUTES } from './routes';
import { startScheduler } from './scheduler';
import { getState } from './store';
import { requestLatency } from './timing';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(init: RequestInit): Promise<{ body: Record<string, unknown>; form: FormData | null }> {
    const raw = init.body;
    if (raw instanceof FormData) return { body: {}, form: raw };
    if (typeof raw !== 'string' || !raw) return { body: {}, form: null };
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { body: parsed as Record<string, unknown>, form: null };
        }
    } catch {
        // ниже — та же ошибка, что у FastAPI на испорченный JSON
    }
    throw new HttpError(422, [{ type: 'json_invalid', loc: ['body'], msg: 'JSON decode error', input: {} }]);
}

export async function demoFetch(path: string, init: RequestInit = {}): Promise<Response> {
    startScheduler();
    getState(); // данные загружены до обработки: пользователи компаний из конструктора известны уже при входе
    const url = new URL(path, 'http://demo.local');
    const method = (init.method ?? 'GET').toUpperCase();
    const matches = ROUTES.map((route) => ({ route, match: route.pattern.exec(url.pathname) })).filter((m) => m.match);
    const found = matches.find((m) => m.route.method === method);
    // небольшая задержка, как у настоящей сети: интерфейс успевает показать загрузку
    if (url.pathname !== '/api/stream') await sleep(requestLatency());
    if (!found) {
        return matches.length ? json({ detail: 'Method Not Allowed' }, 405) : json({ detail: 'Not Found' }, 404);
    }
    try {
        const { body, form } = await readBody(init);
        const ctx: Ctx = {
            method,
            url,
            params: Object.fromEntries(
                Object.entries(found.match?.groups ?? {}).map(([key, value]) => [key, decodeURIComponent(value)]),
            ),
            headers: new Headers(init.headers),
            body,
            form,
            now: Date.now(),
        };
        const result = await found.route.handler(ctx, init.signal);
        return result instanceof Response ? result : json(result ?? null);
    } catch (error) {
        if (error instanceof HttpError) return errorResponse(error);
        console.error('Демо-режим: ошибка обработки запроса', path, error);
        return json({ detail: 'Internal Server Error' }, 500);
    }
}
