import { expect, test } from '@playwright/test';

import { DEMO, login, openAs, resetDemo } from './helpers';

test.beforeEach(async ({ request, page }) => {
    await resetDemo({ request, page });
});

test('поддержка: клиент пишет, администратор находит его в колонке чатов и отвечает', async ({ page, browser }) => {
    const question = 'Где посмотреть график платежей?';
    const answer = 'График — в карточке заявки после выдачи кредита.';

    await login(page, 'veter');
    await expect(page).toHaveURL(/\/client$/);
    await page.getByRole('button', { name: 'Поддержка', exact: true }).click();
    const chat = page.getByRole('dialog', { name: 'Поддержка' });
    await chat.locator('textarea').fill(question);
    await chat.getByRole('button', { name: 'Отправить' }).click();
    await expect(chat.locator('.bubble', { hasText: question })).toBeVisible();

    const admin = await openAs(browser, 'admin', page);
    await expect(admin.page).toHaveURL(/\/bank$/);
    await expect(admin.page.locator('.support__badge')).toHaveText('1');
    await admin.page.getByRole('button', { name: 'Поддержка', exact: true }).click();
    const inbox = admin.page.getByRole('dialog', { name: 'Поддержка' });
    await inbox.getByRole('button', { name: /Северный ветер/ }).click();
    await expect(inbox.locator('.bubble', { hasText: question })).toBeVisible();
    await inbox.locator('textarea').fill(answer);
    await inbox.getByRole('button', { name: 'Отправить' }).click();
    await expect(inbox.locator('.bubble', { hasText: answer })).toBeVisible();
    await expect(admin.page.locator('.support__thread-badge')).toHaveCount(0);

    // На стенде окно клиента открыто в другой вкладке и получает ответ без перезагрузки;
    // в демо-версии данные общие только внутри браузера — входим клиентом снова
    const back = DEMO ? (await openAs(browser, 'veter', admin.page)).page : page;
    if (DEMO) await back.getByRole('button', { name: 'Поддержка', exact: true }).click();
    await expect(back.getByRole('dialog', { name: 'Поддержка' }).locator('.bubble', { hasText: answer })).toBeVisible();
    await admin.close();
});
