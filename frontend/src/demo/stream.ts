// Поток событий (Server-Sent Events) для GET /api/stream: формат и переподключение по Last-Event-ID
// как у сервера (backend/app/api/notifications.py), события берутся из общего хранилища.
import type { DemoUser } from './model';
import { getState, subscribe } from './store';
import { inScope } from './views';

const POLL_MS = 1000;
const PING_EVERY = 15;

export function openStream(user: DemoUser, lastEventId: string | null, signal: AbortSignal | null): Response {
    const encoder = new TextEncoder();
    let cleanup: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const events = () => getState().events;
            const maxId = () => events().reduce((max, e) => Math.max(max, e.id), 0);
            // Без Last-Event-ID поток начинается с текущего момента, с ним — присылает пропущенное
            let lastId = lastEventId && /^\d+$/.test(lastEventId) ? Number(lastEventId) : maxId();
            let closed = false;
            const send = (text: string) => {
                if (!closed) controller.enqueue(encoder.encode(text));
            };
            const flush = () => {
                const fresh = events()
                    .filter((e) => e.id > lastId && inScope(e, user))
                    .sort((a, b) => a.id - b.id);
                for (const e of fresh) {
                    lastId = e.id;
                    const data = { id: e.id, kind: e.kind, application_id: e.app_id, title: e.title, notify: e.notify };
                    send(`id: ${e.id}\nevent: message\ndata: ${JSON.stringify(data)}\n\n`);
                }
            };
            send('retry: 3000\n\n');
            flush();
            const unsubscribe = subscribe(flush);
            let ticks = 0;
            // опрос раз в секунду — как у сервера; заодно ловит изменения из соседних вкладок
            const timer = setInterval(() => {
                flush();
                ticks += 1;
                if (ticks % PING_EVERY === 0) send(': ping\n\n');
            }, POLL_MS);
            cleanup = () => {
                if (closed) return;
                closed = true;
                unsubscribe();
                clearInterval(timer);
            };
            const abort = () => {
                cleanup();
                try {
                    controller.error(new DOMException('The operation was aborted.', 'AbortError'));
                } catch {
                    // поток уже закрыт
                }
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort);
        },
        cancel() {
            cleanup();
        },
    });
    return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
}
