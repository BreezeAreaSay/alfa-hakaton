import { expect, test } from '@playwright/test';

import { login, openAs, resetDemo } from './helpers';

test.beforeEach(async ({ request, page }) => {
    await resetDemo({ request, page });
});

test('аналитик рассматривает заявку вручную и одобряет её, клиент видит предложение', async ({ page, browser }) => {
    await login(page, 'analyst');
    await expect(page.getByRole('heading', { level: 1, name: 'Очередь заявок' })).toBeVisible();

    // Стартовые заявки распределены автоматически по порядку номеров: первая — analyst, вторая — analyst2
    const own = page.getByRole('row', { name: /Вектор Логистик/ });
    await expect(own).toContainText('Средний');
    await expect(own).toContainText('Иванова О. Д. · вы');

    // Заявка под залог всегда идёт на ручное рассмотрение
    const row = page.getByRole('row', { name: /Гранд Девелопмент/ });
    await expect(row).toContainText('Ручное рассмотрение');
    await expect(row).toContainText('Ковалёв П. И.');
    await row.click();
    await expect(page.getByRole('heading', { name: 'ООО «Гранд Девелопмент»' })).toBeVisible();

    // В шапке досье — приоритет с причиной; заявку коллеги аналитик забирает себе
    const head = page.locator('.bank-head');
    await expect(head.getByText('Средний', { exact: true })).toBeVisible();
    await expect(head.getByText('Сумма от 10 млн ₽', { exact: true })).toBeVisible();
    await expect(head.getByText('Ковалёв Павел Игоревич', { exact: true })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Взять в работу' })).toHaveCount(0);
    await head.getByRole('button', { name: 'Взять себе' }).click();
    await expect(head.getByText('Иванова Ольга Дмитриевна (вы)', { exact: true })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Взять себе' })).toBeHidden();

    const panel = page.getByRole('region', { name: 'Решение по заявке' });
    await panel.getByRole('group', { name: 'Действие' }).getByRole('button', { name: 'Одобрить' }).click();
    const approve = panel.getByRole('button', { name: 'Одобрить', exact: true }).last();
    await expect(approve).toBeEnabled(); // условия пересчитаны, ограничений политики нет
    await approve.click();
    await expect(page.getByText('Предложение выдано').first()).toBeVisible();

    // Клиент в своём кабинете сразу видит одобрение
    const { page: client, close } = await openAs(browser, 'grand', page);
    await expect(client.locator('table')).toContainText('Предложение готово');
    await client.getByRole('row', { name: /Предложение готово/ }).click();
    await expect(client.getByRole('heading', { name: 'Кредит одобрен' })).toBeVisible();
    await close();
});

test('сотрудник банка не может открыть кабинет клиента', async ({ page }) => {
    await login(page, 'analyst');
    await expect(page).toHaveURL(/\/bank$/);
    await page.goto('/client');
    await expect(page).toHaveURL(/\/bank$/);
});
