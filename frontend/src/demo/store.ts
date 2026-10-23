// Хранилище имитации: все демо-данные лежат в localStorage под одним ключом и общие для всех
// демо-пользователей этого браузера. Загруженные клиентом файлы — только в памяти вкладки.
import { FIXTURES_VERSION } from './data';
import type { DemoState } from './model';
import { STATE_VERSION, initialState } from './seed';

export const STORAGE_KEY = 'credit-cabinet-demo-state-v1';

let state: DemoState | null = null;
let saved: string | null = null;
const listeners = new Set<() => void>();

/** Содержимое файлов, загруженных в этой вкладке (после перезагрузки страницы их нет). */
export const files = new Map<string, Blob>();

function storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

function parse(raw: string | null): DemoState | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as DemoState;
        if (parsed.version !== STATE_VERSION || parsed.fixtures !== FIXTURES_VERSION) return null;
        // Данные, сохранённые до чата с поддержкой: заявки не сбрасываем, просто добавляем пустой чат
        parsed.support ??= [];
        return parsed;
    } catch {
        return null;
    }
}

function persist(next: DemoState): void {
    saved = JSON.stringify(next);
    try {
        storage()?.setItem(STORAGE_KEY, saved);
    } catch {
        // хранилище переполнено или недоступно — данные живут до перезагрузки страницы
    }
}

export function getState(): DemoState {
    if (state) return state;
    let raw: string | null = null;
    try {
        raw = storage()?.getItem(STORAGE_KEY) ?? null;
    } catch {
        raw = null;
    }
    state = parse(raw);
    if (state) saved = raw;
    else {
        state = initialState(Date.now());
        persist(state);
    }
    return state;
}

const notify = () => queueMicrotask(() => listeners.forEach((listener) => listener()));

/** Перечитать данные из localStorage, если их изменила другая вкладка. */
export function reload(): void {
    let raw: string | null = null;
    try {
        raw = storage()?.getItem(STORAGE_KEY) ?? null;
    } catch {
        return;
    }
    if (raw === null || raw === saved) return;
    const next = parse(raw);
    if (!next) return;
    state = next;
    saved = raw;
    notify();
}

/** Изменение данных одной транзакцией: при ошибке всё возвращается к сохранённому состоянию. */
export function transact<T>(fn: (current: DemoState) => T): T {
    const current = getState();
    let result: T;
    try {
        result = fn(current);
    } catch (error) {
        state = parse(saved);
        throw error;
    }
    persist(current);
    notify();
    return result;
}

/** Полная замена данных (сброс демо-стенда). */
export function replaceState(next: DemoState): void {
    state = next;
    files.clear();
    persist(next);
    notify();
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// Изменения из соседней вкладки того же браузера: перечитываем данные и будим подписчиков
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        if (event.key !== null && event.key !== STORAGE_KEY) return;
        const next = parse(event.newValue);
        state = next;
        saved = next ? event.newValue : null;
        notify();
    });
}
