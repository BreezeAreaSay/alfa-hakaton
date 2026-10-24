import { defineConfig, devices } from '@playwright/test';

// Демо-версия без сервера (E2E_DEMO=1): сборка frontend с имитацией API, раздаётся через vite preview.
const demo = process.env.E2E_DEMO === '1';
const demoUrl = 'http://localhost:4173';

// Аудит доступности (tests/a11y.spec.ts) — отдельный проект, который включается только явно (E2E_A11Y=1,
// npm run test:a11y), чтобы не удваивать прогон сценариев в test, test:demo и CI.
const a11y = process.env.E2E_A11Y === '1';

// Тесты идут по общим демо-данным (перед каждым тестом — сброс), поэтому строго последовательно.
export default defineConfig({
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    // В CI одна повторная попытка: раннер с двумя ядрами под нагрузкой сборки образов и конвейера иногда не
    // укладывается в таймауты ожидания; локально повторов нет, чтобы нестабильность была видна сразу
    retries: process.env.CI ? 1 : 0,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: process.env.E2E_BASE_URL ?? (demo ? demoUrl : 'http://localhost:8080'),
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        viewport: { width: 1440, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    // Без своего адреса в демо-режиме собираем демо-версию и поднимаем vite preview
    webServer:
        demo && !process.env.E2E_BASE_URL
            ? {
                  command: 'npm run build:demo -- --logLevel error && npm run preview -- --port 4173 --strictPort',
                  cwd: '../frontend',
                  url: demoUrl,
                  reuseExistingServer: !process.env.CI,
                  timeout: 180_000,
              }
            : undefined,
    projects: [
        {
            name: 'chromium',
            testIgnore: /a11y\.spec\.ts/,
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1440, height: 900 },
                // Можно указать уже установленный Chromium вместо скачивания браузеров Playwright
                launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
            },
        },
        {
            // Кабинет клиента адаптирован под телефон: те же сценарии клиента на экране 390×844
            name: 'mobile-client',
            testMatch: /client\.spec\.ts/,
            use: {
                ...devices['iPhone 13'],
                defaultBrowserType: 'chromium',
                launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
            },
        },
        ...(a11y
            ? [
                  {
                      name: 'a11y',
                      testMatch: /a11y\.spec\.ts/,
                      use: {
                          ...devices['Desktop Chrome'],
                          viewport: { width: 1440, height: 900 },
                          launchOptions: process.env.PW_CHROMIUM_PATH
                              ? { executablePath: process.env.PW_CHROMIUM_PATH }
                              : {},
                      },
                  },
              ]
            : []),
    ],
});
