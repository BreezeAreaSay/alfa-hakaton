#!/usr/bin/env node
/**
 * Сверка имитации сервера (src/demo) с ответами настоящего API, снятыми скриптом capture-demo-fixtures.mjs.
 * Проходит сценарии всех тестовых компаний через demoFetch в Node и сравнивает статусы, предложения,
 * расчёты, досье, тексты ошибок и уведомлений; разбор потребности — на эталонном наборе фраз.
 *
 *   cd frontend && npm run demo:check
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runnerImport } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();
const { module } = await runnerImport('/src/demo/selfcheck.ts', { root, configFile: false, logLevel: 'error' });
const ok = await module.run({
    readFile: async (path) => new Uint8Array(await readFile(join(root, path))),
    log: (line) => console.log(line),
});
console.log(`Время: ${((Date.now() - started) / 1000).toFixed(1)} с`);
process.exit(ok ? 0 : 1);
