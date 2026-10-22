import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

export const PASSWORD = 'admin';

/**
 * Демо-версия без сервера (E2E_DEMO=1): API имитируется в браузере, данные лежат в localStorage
 * и общие для всех учётных записей этого браузера.
 */
export const DEMO = process.env.E2E_DEMO === '1';

/**
 * Возвращает демо-данные в исходное состояние: заявки удаляются, сбои симулятора снимаются.
 * В демо-версии данные живут в браузере — достаточно очистить хранилище.
 */
export async function resetDemo({ request, page }: { request: APIRequestContext; page: Page }): Promise<void> {
    if (DEMO) {
        await page.goto('/login');
        await page.evaluate(() => localStorage.clear());
        return;
    }
    const token = await apiToken(request, 'admin');
    const response = await request.post('/api/admin/demo/reset', { headers: { Authorization: `Bearer ${token}` } });
    expect(response.ok(), await response.text()).toBeTruthy();
}

export async function apiToken(request: APIRequestContext, login: string): Promise<string> {
    const response = await request.post('/api/auth/login', { data: { login, password: PASSWORD } });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).token as string;
}

export async function login(page: Page, username: string, password = PASSWORD): Promise<void> {
    await page.goto('/login');
    await page.locator('input[name="login"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

/**
 * Второй участник сценария (например, клиент после решения аналитика): отдельная вкладка с отдельной
 * сессией. В демо-версии данные общие только внутри одного браузера, поэтому там же выходим и входим
 * под другой учётной записью.
 */
export async function openAs(
    browser: Browser,
    username: string,
    current: Page,
): Promise<{ page: Page; close: () => Promise<void> }> {
    if (DEMO) {
        await current.getByRole('button', { name: 'Выйти' }).click();
        await expect(current).toHaveURL(/\/login$/);
        await login(current, username);
        return { page: current, close: async () => undefined };
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, username);
    return { page, close: () => context.close() };
}

/** Суммы в интерфейсе форматируются с неразрывными пробелами: «3 000 000 ₽». */
export function money(value: number): RegExp {
    const digits = value.toLocaleString('ru-RU').replace(/\s/g, '\\s');
    return new RegExp(`${digits}\\s?₽`);
}
