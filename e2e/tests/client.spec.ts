import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { login, money, PASSWORD, resetDemo } from './helpers';

const DEMO_FILES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/public/demo-files');

test.beforeEach(async ({ request }) => {
    await resetDemo(request);
});

/** Шаг «Подбор»: описание задачи → распознанные параметры → выбор продукта. */
async function chooseProduct(page: Page, need: string, product: string): Promise<void> {
    await page.getByRole('button', { name: 'Подобрать кредит' }).first().click();
    await expect(page).toHaveURL(/\/client\/new/);
    await page.locator('textarea').first().fill(need);
    await page.getByRole('button', { name: 'Подобрать по описанию' }).click();
    await expect(page.getByText(/^Распознали:/)).toBeVisible();
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: product, exact: true }) });
    await card.getByRole('button', { name: 'Оформить заявку' }).click();
}

/** Шаги «Данные» и «Проверка и отправка». */
async function submitApplication(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Далее' }).click();
    const consents = [
        'Согласие на запрос кредитной истории в бюро кредитных историй',
        'Согласие на обработку персональных данных',
    ];
    for (const consent of consents) {
        // Как пользователь: нажатием на подпись (поверх нативного поля лежит декоративный элемент)
        await page.getByText(consent, { exact: true }).click();
        await expect(page.getByRole('checkbox', { name: consent })).toBeChecked();
    }
    await page.getByRole('button', { name: 'Отправить заявку' }).click();
    await expect(page).toHaveURL(/\/client\/applications\/[0-9a-f-]+$/);
}

test('ключевой сценарий: подбор, заявка, автоодобрение, подписание и выдача кредита', async ({ page }) => {
    await login(page, 'veter');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Добрый день');

    await chooseProduct(page, 'Нужно 3 млн на закупку товара к сезону, верну за 2 года', 'Кредит на развитие бизнеса');
    await expect(page.getByText('Кредит на развитие бизнеса').first()).toBeVisible();
    await submitApplication(page);

    // Конвейер проверок проходит автоматически, статус обновляется без перезагрузки страницы
    await expect(page.getByRole('heading', { name: 'Кредит одобрен' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Варианты условий' })).toContainText(money(3_000_000));
    await expect(page.getByText('Что повлияло на условия')).toBeVisible();
    await page.getByRole('button', { name: 'Принять предложение' }).click();

    // Договор формируется автоматически, затем подписание паролем от кабинета
    await page.getByRole('button', { name: 'Подписать договор' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="password"]').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Подписать', exact: true }).click();

    await expect(page.getByText('Кредит выдан').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Основной долг' })).toBeVisible();
    await expect(page.getByText('Ближайший платёж')).toBeVisible();

    // В списке заявок на главной — выданный кредит
    await page.goto('/client');
    await expect(page.locator('table')).toContainText('Кредит выдан');
});

test('банку не хватает данных: клиент загружает выписку и получает предложение', async ({ page }) => {
    await login(page, 'orlov');
    await chooseProduct(page, 'Нужно 1 500 000 на закупку товара на 2 года', 'Экспресс-кредит без залога');
    await submitApplication(page);

    await expect(page.getByText('Нужна информация').first()).toBeVisible();
    await page.locator('input[type="file"][accept=".txt,.csv"]').setInputFiles(path.join(DEMO_FILES, 'vypiska_orlov_1c.txt'));
    await expect(page.getByText('vypiska_orlov_1c.txt').first()).toBeVisible();
    await page.getByRole('button', { name: 'Отправить ответ' }).click();

    await expect(page.getByRole('heading', { name: /Кредит одобрен|Банк предлагает другие условия/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Принять предложение' })).toBeEnabled();
});

test('стоп-фактор: компания в ликвидации получает отказ с понятной причиной', async ({ page }) => {
    await login(page, 'romashka');
    await chooseProduct(page, 'Нужно 2 млн на закупку товара на год', 'Кредит на развитие бизнеса');
    await submitApplication(page);

    await expect(page.getByRole('heading', { name: 'Банк не может выдать кредит' })).toBeVisible();
    await expect(page.getByText(/ликвидац/i).first()).toBeVisible();
});

test('вход с неверным паролем и разграничение доступа по ролям', async ({ page }) => {
    await login(page, 'veter', 'wrong-password');
    await expect(page.getByText('Не удалось войти')).toBeVisible();

    await login(page, 'veter');
    await expect(page).toHaveURL(/\/client$/);
    await page.goto('/bank');
    await expect(page).toHaveURL(/\/client$/);
});
