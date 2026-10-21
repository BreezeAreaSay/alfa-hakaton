import { expect, test } from '@playwright/test';

import { login, openAs, resetDemo } from './helpers';

test.beforeEach(async ({ request }) => {
    await resetDemo(request);
});

test('аналитик рассматривает заявку вручную и одобряет её, клиент видит предложение', async ({ page, browser }) => {
    await login(page, 'analyst');
    await expect(page.getByRole('heading', { level: 1, name: 'Очередь заявок' })).toBeVisible();

    // Заявка под залог всегда идёт на ручное рассмотрение
    const row = page.getByRole('row', { name: /Гранд Девелопмент/ });
    await expect(row).toContainText('Ручное рассмотрение');
    await row.click();
    await expect(page.getByRole('heading', { name: 'ООО «Гранд Девелопмент»' })).toBeVisible();

    await page.getByRole('button', { name: 'Взять в работу' }).click();
    await expect(page.getByRole('button', { name: 'Взять в работу' })).toBeHidden();

    const panel = page.getByRole('region', { name: 'Решение по заявке' });
    await panel.getByRole('group', { name: 'Действие' }).getByRole('button', { name: 'Одобрить' }).click();
    const approve = panel.getByRole('button', { name: 'Одобрить', exact: true }).last();
    await expect(approve).toBeEnabled(); // условия пересчитаны, ограничений политики нет
    await approve.click();
    await expect(page.getByText('Предложение выдано').first()).toBeVisible();

    // Клиент в своём кабинете сразу видит одобрение
    const client = await openAs(browser, 'grand');
    await expect(client.locator('table')).toContainText('Предложение готово');
    await client.getByRole('row', { name: /Предложение готово/ }).click();
    await expect(client.getByRole('heading', { name: 'Кредит одобрен' })).toBeVisible();
    await client.context().close();
});

test('сотрудник банка не может открыть кабинет клиента', async ({ page }) => {
    await login(page, 'analyst');
    await expect(page).toHaveURL(/\/bank$/);
    await page.goto('/client');
    await expect(page).toHaveURL(/\/bank$/);
});
