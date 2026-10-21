/** Имитация сервера для демо-режима. Заглушка: полноценная реализация подключается отдельно. */
export async function demoFetch(path: string, _init: RequestInit = {}): Promise<Response> {
    return new Response(JSON.stringify({ detail: `Демо-режим: ${path} не реализован` }), {
        status: 501,
        headers: { 'Content-Type': 'application/json' },
    });
}
