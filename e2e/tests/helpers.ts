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

/** Вход через кнопку «Войти» в шапке стартовой страницы: форма — в окне поверх страницы. */
export async function login(page: Page, username: string, password = PASSWORD): Promise<void> {
    await page.goto('/login');
    await page.getByRole('banner').getByRole('button', { name: 'Войти', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Вход' });
    await dialog.locator('input[name="login"]').fill(username);
    await dialog.locator('input[name="password"]').fill(password);
    await dialog.getByRole('button', { name: 'Войти', exact: true }).click();
}

/** Выход: кнопка с дверью в шапке и подтверждение в окне по центру. */
export async function logout(page: Page): Promise<void> {
    await page.getByRole('banner').getByRole('button', { name: 'Выйти' }).click();
    await page.getByRole('dialog', { name: 'Выйти из кабинета?' }).getByRole('button', { name: 'Выйти' }).click();
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
        await logout(current);
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
