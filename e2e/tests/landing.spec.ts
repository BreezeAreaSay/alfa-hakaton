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

test('продукты: у гостя меню нет, на странице задача подсвечивает подходящие продукты', async ({ page }) => {
    await page.goto('/');
    // меню «Главная / Продукты / Получить кредит» — только после входа
    await expect(page.getByRole('banner').getByRole('link', { name: 'Продукты' })).toHaveCount(0);

    await page.goto('/products');
    await expect(page.getByRole('heading', { level: 1, name: 'Какой продукт нужен вашему бизнесу?' })).toBeVisible();
    await expect(page.locator('.products-card')).toHaveCount(6);

    await page.getByRole('button', { name: 'Кассовый разрыв' }).click();
    const overdraft = page.locator('.products-card').filter({ has: page.getByRole('heading', { name: 'Овердрафт' }) });
    await expect(overdraft).toHaveClass(/products-card--match/);
});
