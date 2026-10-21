// Таймеры обработчика конвейера в браузере. Если открыто несколько вкладок, задания выполняет одна
// (Web Locks API) — та, на которую смотрят: таймеры фоновых вкладок браузер замедляет. Остальные вкладки
// видят результат через localStorage.
import { hasExpired, nextJob, runDueJob, sweep } from './pipeline';
import { getState, reload, subscribe, transact } from './store';

const SWEEP_MS = 10_000;
const LOCK = 'credit-cabinet-demo-pipeline';

let leader = false;
let started = false;
let queued = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function plan(): void {
    if (!leader) return;
    if (timer) clearTimeout(timer);
    const job = nextJob(getState());
    const delay = job ? Math.min(Math.max(job.run_at - Date.now(), 0), SWEEP_MS) : SWEEP_MS;
    timer = setTimeout(tick, delay);
}

function tick(): void {
    timer = null;
    if (!leader) return;
    try {
        const now = Date.now();
        for (let guard = 0; guard < 200; guard += 1) {
            const job = nextJob(getState());
            if (!job || job.run_at > now) break;
            try {
                transact((state) => runDueJob(state, now));
            } catch (error) {
                // задание с ошибкой снимаем, чтобы не повторять его бесконечно
                console.warn('Демо-режим: ошибка задания конвейера', error);
                transact((state) => {
                    state.jobs = state.jobs.filter((j) => j.id !== job.id);
                });
            }
        }
        if (hasExpired(getState(), now)) transact((state) => sweep(state, now));
    } finally {
        plan();
    }
}

/** Разбудить обработчик: появились новые задания или изменились сроки. */
export function kick(): void {
    if (!leader) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, 0);
}

function lead(): void {
    leader = true;
    reload(); // прежний обработчик мог успеть изменить данные
    kick();
}

function resign(): void {
    leader = false;
    if (timer) clearTimeout(timer);
    timer = null;
}

/**
 * Встать в очередь за замком обработчика (steal = false) или забрать его сразу (steal = true).
 * Замок держится, пока открыта вкладка или пока его не заберёт вкладка, на которую переключились.
 */
function claim(locks: LockManager, steal: boolean): void {
    if (!steal) {
        if (queued) return;
        queued = true;
    }
    locks
        .request(LOCK, { steal }, () => {
            if (!steal) queued = false;
            lead();
            return new Promise<void>(() => undefined);
        })
        .catch(() => {
            // замок забрала другая вкладка — ждём своей очереди
            resign();
            claim(locks, false);
        });
}

export function startScheduler(): void {
    if (started) return;
    started = true;
    // Данные изменились (в том числе в соседней вкладке) — пересчитываем ближайший таймер
    subscribe(() => plan());
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request || typeof document === 'undefined') {
        lead();
        return;
    }
    claim(locks, document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !leader) claim(locks, true);
    });
}
