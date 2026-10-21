import { getToken } from './client';

export interface StreamEvent {
    id: number;
    kind: string;
    application_id: string | null;
    title: string;
    notify: boolean;
}

/**
 * Поток событий через fetch (Server-Sent Events): так токен уходит в заголовке, а не в адресе.
 * При обрыве соединения переподключается и продолжает с последнего события.
 */
export function subscribe(onEvent: (event: StreamEvent) => void): () => void {
    let stopped = false;
    let lastId: string | null = null;
    let controller: AbortController | null = null;

    const run = async () => {
        while (!stopped) {
            controller = new AbortController();
            try {
                const headers: Record<string, string> = { Accept: 'text/event-stream' };
                const token = getToken();
                if (token) headers.Authorization = `Bearer ${token}`;
                if (lastId) headers['Last-Event-ID'] = lastId;
                const response = await fetch('/api/stream', { headers, signal: controller.signal });
                if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (!stopped) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let index: number;
                    while ((index = buffer.indexOf('\n\n')) >= 0) {
                        const chunk = buffer.slice(0, index);
                        buffer = buffer.slice(index + 2);
                        let data = '';
                        for (const line of chunk.split('\n')) {
                            if (line.startsWith('id:')) lastId = line.slice(3).trim();
                            else if (line.startsWith('data:')) data += line.slice(5).trim();
                        }
                        if (data) {
                            try {
                                onEvent(JSON.parse(data) as StreamEvent);
                            } catch {
                                // пропускаем битое событие
                            }
                        }
                    }
                }
            } catch {
                // сеть или сервер недоступны — переподключимся
            }
            if (!stopped) await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    };
    void run();
    return () => {
        stopped = true;
        controller?.abort();
    };
}
