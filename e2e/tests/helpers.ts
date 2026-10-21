import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

export const PASSWORD = 'demo';

/** Возвращает демо-данные в исходное состояние: заявки удаляются, сбои симулятора снимаются. */
export async function resetDemo(request: APIRequestContext): Promise<void> {
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

/** Отдельная вкладка с отдельной сессией — чтобы в одном тесте действовали клиент и сотрудник банка. */
export async function openAs(browser: Browser, username: string): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, username);
    return page;
}

/** Суммы в интерфейсе форматируются с неразрывными пробелами: «3 000 000 ₽». */
export function money(value: number): RegExp {
    const digits = value.toLocaleString('ru-RU').replace(/\s/g, '\\s');
    return new RegExp(`${digits}\\s?₽`);
}
