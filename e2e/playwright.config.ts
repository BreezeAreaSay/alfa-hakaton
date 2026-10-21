import { defineConfig, devices } from '@playwright/test';

// Тесты идут по общим демо-данным (перед каждым тестом — сброс), поэтому строго последовательно.
export default defineConfig({
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        viewport: { width: 1440, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1440, height: 900 },
                // Можно указать уже установленный Chromium вместо скачивания браузеров Playwright
                launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
            },
        },
    ],
});
