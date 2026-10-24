import { expect, test } from '@playwright/test';

import { resetDemo } from './helpers';

test.beforeEach(async ({ request, page }) => {
    await resetDemo({ request, page });
});

test('регистрация: окно из шапки, без логики сообщает, что появится позже, и ведёт ко входу', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('banner').getByRole('button', { name: 'Регистрация' }).click();

    const register = page.getByRole('dialog', { name: 'Регистрация' });
    await register.locator('input[name="inn"]').fill('7701234567');
    await register.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(register.getByText('Регистрация появится позже')).toBeVisible();

    await register.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Вход' }).locator('input[name="login"]')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Регистрация' })).toHaveCount(0);
});

test('продукты: гость выбирает задачу, видит подходящие продукты и после входа попадает в подбор', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Продукты' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Какой продукт нужен вашему бизнесу?' })).toBeVisible();
    await expect(page.locator('.products-card')).toHaveCount(6);

    await page.getByRole('button', { name: 'Кассовый разрыв' }).click();
    const overdraft = page.locator('.products-card').filter({ has: page.getByRole('heading', { name: 'Овердрафт' }) });
    await expect(overdraft).toHaveClass(/products-card--match/);

    await overdraft.getByRole('button', { name: 'Рассчитать' }).click();
    const dialog = page.getByRole('dialog', { name: 'Вход' });
    await dialog.getByRole('button', { name: /veter/ }).click();
    await expect(page).toHaveURL(/\/client\/new\?purpose=CASH_GAP/);
    await expect(page.getByRole('button', { name: 'Кассовый разрыв', pressed: true })).toBeVisible();
});
