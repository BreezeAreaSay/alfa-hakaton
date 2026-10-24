import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { login, logout, money, PASSWORD, resetDemo } from './helpers';

const DEMO_FILES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/public/demo-files');

test.beforeEach(async ({ request, page }) => {
    await resetDemo({ request, page });
});

/** Шаг «Подбор»: описание задачи своими словами → «Я понял так» → выбор продукта. */
async function chooseProduct(page: Page, need: string, product: string): Promise<void> {
    await page.getByRole('button', { name: 'Подобрать кредит' }).first().click();
    await expect(page).toHaveURL(/\/client\/new/);
    await page.getByRole('button', { name: 'Или опишите задачу своими словами' }).click();
    await page.locator('textarea').first().fill(need);
    await page.getByRole('button', { name: 'Подобрать по описанию' }).click();
    await expect(page.getByText('Я понял так', { exact: true })).toBeVisible();
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: product, exact: true }) });
    await card.getByRole('button', { name: 'Оформить заявку' }).click();
}

/**
 * Шаги «Данные» и «Проверка и отправка». Выручка обязательна; в тестах — близкая к данным ФНС или оборотам
 * компании, иначе расхождение больше 30% отправит заявку аналитику (флаг F04) и исход сценария изменится.
 */
async function submitApplication(page: Page, revenue: number): Promise<void> {
    await page.getByLabel('Выручка за последний год').fill(String(revenue));
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
    // без выручки дальше не пускает
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Укажите выручку за последний год')).toBeVisible();
    await submitApplication(page, 120_000_000);

    // Конвейер проверок проходит автоматически, статус обновляется без перезагрузки страницы
    await expect(page.getByRole('heading', { name: 'Кредит одобрен' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Варианты условий' })).toContainText(money(3_000_000));
    await expect(page.getByText('Что повлияло на условия')).toBeVisible();
    await page.getByRole('button', { name: 'Принять предложение' }).click();

    // Договор формируется автоматически, затем подписание паролем от кабинета: фокус сразу в поле, Enter подписывает
    await page.getByRole('button', { name: 'Подписать договор' }).click();
    const password = page.getByRole('dialog').locator('input[type="password"]');
    await expect(password).toBeFocused();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');

    await expect(page.getByText('Кредит выдан').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Остаток' })).toBeVisible();
    await expect(page.getByText('Ближайший платёж')).toBeVisible();

    // В списке заявок на главной — выданный кредит; строка открывается с клавиатуры
    await page.goto('/client');
    await expect(page.locator('table')).toContainText('Кредит выдан');
    await page.getByRole('row', { name: /Кредит выдан/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/client\/applications\/[0-9a-f-]+$/);
    await expect(page.getByText('Ближайший платёж')).toBeVisible();
});

test('банку не хватает данных: клиент загружает выписку и получает предложение', async ({ page }) => {
    await login(page, 'orlov');
    await chooseProduct(page, 'Нужно 1 500 000 на закупку товара на 2 года', 'Экспресс-кредит без залога');
    await submitApplication(page, 8_400_000);

    await expect(page.getByText('Нужна информация').first()).toBeVisible();
    await page
        .locator('input[type="file"][accept=".txt,.csv"]')
        .setInputFiles(path.join(DEMO_FILES, 'vypiska_orlov_1c.txt'));
    await expect(page.getByText('vypiska_orlov_1c.txt').first()).toBeVisible();
    await page.getByRole('button', { name: 'Отправить ответ' }).click();

    await expect(
        page.getByRole('heading', {
            name: /Кредит одобрен|Банк предлагает другие условия/,
        }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Принять предложение' })).toBeEnabled();
});

test('стоп-фактор: компания в ликвидации получает отказ с понятной причиной', async ({ page }) => {
    await login(page, 'romashka');
    await chooseProduct(page, 'Нужно 2 млн на закупку товара на год', 'Кредит на развитие бизнеса');
    await submitApplication(page, 9_000_000);

    await expect(page.getByRole('heading', { name: 'Банк не может выдать кредит' })).toBeVisible();
    await expect(page.getByText(/ликвидац/i).first()).toBeVisible();
    // Стоп-фактор не зависит от продукта: подбор другого продукта не предлагаем
    await expect(page.getByRole('button', { name: 'Подобрать другой продукт' })).toHaveCount(0);
});

test('вход с неверным паролем и разграничение доступа по ролям', async ({ page }) => {
    await login(page, 'veter', 'wrong-password');
    await expect(page.getByText('Не удалось войти')).toBeVisible();

    // Перебор паролей: после пяти неверных паролей логин блокируется на 5 минут (блокировка могла
    // остаться от предыдущего прогона, поэтому останавливаемся, как только она показана)
    const blocked = page.getByText(/Слишком много попыток входа/);
    for (let attempt = 1; attempt <= 5 && !(await blocked.isVisible()); attempt++) {
        await login(page, 'nobody', 'wrong-password');
        await expect(page.getByText('Не удалось войти')).toBeVisible();
    }
    await expect(blocked).toBeVisible();

    // другие пользователи входят как обычно
    await login(page, 'veter');
    await expect(page).toHaveURL(/\/client$/);
    await page.goto('/bank');
    await expect(page).toHaveURL(/\/client$/);
});

test('логотип возвращает вошедшего клиента на стартовую страницу с баннерами', async ({ page }) => {
    await login(page, 'veter');
    await expect(page).toHaveURL(/\/client$/);

    await page.getByRole('link', { name: 'На главную' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: /Кредиты для бизнеса/ })).toBeVisible();
    // вошедшему окно входа не нужно: «Получить кредит» ведёт сразу в подбор. На телефоне этой кнопки в шапке нет —
    // то же действие у «Оформить заявку» на баннере, а «Личный кабинет» подписан коротко: «Кабинет»
    const phone = test.info().project.name === 'mobile-client';
    const start = phone
        ? page.getByRole('button', { name: 'Оформить заявку' })
        : page.getByRole('banner').getByRole('button', { name: 'Получить кредит' });
    await start.click();
    await expect(page).toHaveURL(/\/client\/new$/);

    await page.getByRole('link', { name: 'На главную' }).click();
    await page
        .getByRole('banner')
        .getByRole('button', { name: phone ? 'Кабинет' : 'Личный кабинет', exact: true })
        .click();
    await expect(page).toHaveURL(/\/client$/);
});

test('выход из кабинета — только после подтверждения в окне', async ({ page }) => {
    await login(page, 'veter');
    await expect(page).toHaveURL(/\/client$/);

    await page.getByRole('banner').getByRole('button', { name: 'Выйти' }).click();
    const confirm = page.getByRole('dialog', { name: 'Выйти из кабинета?' });
    await confirm.getByRole('button', { name: 'Остаться' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page).toHaveURL(/\/client$/);

    await logout(page);
    await expect(page).toHaveURL(/\/login$/);
});

test('выписка с кассовым разрывом: прогноз и подсказка лимита овердрафта', async ({ page }) => {
    await login(page, 'smirnova');
    await chooseProduct(page, 'Нужно 1 000 000 на год, закрыть кассовый разрыв', 'Овердрафт');

    // Выписка не обязательна для клиента банка, но по ней строится прогноз денежного потока
    await page
        .locator('input[type="file"][accept=".txt,.csv"]')
        .setInputFiles(path.join(DEMO_FILES, 'vypiska_smirnova.csv'));
    await expect(page.getByText('vypiska_smirnova.csv').first()).toBeVisible();
    await expect(page.getByText('возможен кассовый разрыв').first()).toBeVisible();
    await expect(page.getByText(/Подойдёт овердрафт до/).first()).toContainText(money(250_000));

    await submitApplication(page, 13_200_000);
    await expect(page.getByRole('heading', { name: 'Банк предлагает другие условия' })).toBeVisible();
    await expect(page.getByText('возможен кассовый разрыв').first()).toBeVisible();
});
