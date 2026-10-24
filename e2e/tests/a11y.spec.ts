/**
 * Автоматический аудит доступности (axe-core) по экранам кабинета клиента, рабочего места аналитика
 * и страницы администратора. Проверяются правила WCAG 2.0 и 2.1 уровней A и AA; правила best-practice
 * не включаются.
 *
 * Запуск на демо-версии без сервера (демо-сборка и vite preview поднимутся сами, см. playwright.config.ts):
 *   cd e2e && npm run test:a11y
 * На уже поднятом адресе (демо-превью или полный стек) — те же переменные, что у остальных тестов, плюс E2E_A11Y=1:
 * он включает проект a11y, который по умолчанию выключен, чтобы не удваивать прогон сценариев в test и test:demo.
 *   E2E_DEMO=1 E2E_A11Y=1 E2E_BASE_URL=http://localhost:4180 npx playwright test --project=a11y
 *   E2E_A11Y=1 E2E_BASE_URL=http://localhost:8080 npx playwright test --project=a11y
 *
 * Нарушения уровней serious и critical валят тест; moderate и minor печатаются в консоль как предупреждения.
 * Полный результат axe по каждому экрану прикладывается к тесту (axe-results.json), его видно в HTML-отчёте.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { login, PASSWORD, resetDemo } from './helpers';

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type Violation = AxeResults['violations'][number];
type ViolationNode = Violation['nodes'][number];

/** Теги правил axe: WCAG 2.0 и 2.1 уровней A и AA. Правила с тегом best-practice при таком списке не запускаются. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Нарушения этих уровней валят тест; остальные (moderate, minor) только печатаются. */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/** Сколько селекторов элементов показывать по каждому правилу. */
const SELECTORS_SHOWN = 3;

/**
 * Что не сканируем и почему — это решения вне кода приложения:
 *  - подпись фирменной красной кнопки (тема corp дизайн-системы): белый текст на #ef3124 даёт 3,8–4,1:1 при
 *    норме 4,5:1, цвет бренда не меняем; сама кнопка (имя, роль, фокус) проверяется;
 *  - фильтр по продукту в очереди: Select дизайн-системы разносит атрибуты combobox по двум элементам
 *    (aria-expanded на внешнем, aria-controls на внутреннем), поэтому axe видит безымянный combobox и ссылку на
 *    ещё не отрисованное меню; подпись полю дана (label), остальное — разметка дизайн-системы;
 *  - кнопка «показать пароль» в PasswordInput и индикатор пройденных шагов в Steps: иконка role="img" без имени
 *    внутри компонентов дизайн-системы, снаружи не правится.
 */
const DESIGN_SYSTEM_EXCLUDES = [
    'button[class*="button__primary_"] [class*="button__label_"]',
    '.bank-product [role="combobox"]',
    '[class*="password-input__eye_"]',
    '.steps-card__full svg',
];

/** Селектор элемента: части через теневой DOM соединяются «»», уровни фреймов — «›». */
const selectorOf = (node: ViolationNode): string =>
    node.target.map((part) => (Array.isArray(part) ? part.join(' » ') : String(part))).join(' › ');

const describeViolation = (violation: Violation): string => {
    const selectors = violation.nodes.slice(0, SELECTORS_SHOWN).map(selectorOf).join(' | ');
    const more = violation.nodes.length > SELECTORS_SHOWN ? ` и ещё ${violation.nodes.length - SELECTORS_SHOWN}` : '';
    return (
        `${violation.id} [${violation.impact ?? 'без уровня'}] — ${violation.description} ` +
        `(элементов: ${violation.nodes.length}): ${selectors}${more}`
    );
};

/**
 * Проверяет текущее состояние страницы правилами WCAG A/AA. Перед проверкой дожидается, пока исчезнут
 * индикаторы загрузки, чтобы не оценивать промежуточное состояние.
 */
async function checkA11y(page: Page, screen: string, testInfo: TestInfo): Promise<void> {
    await expect(page.getByText(/^(Загружаем|Подбираем продукты)/)).toHaveCount(0);

    const builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
    for (const selector of DESIGN_SYSTEM_EXCLUDES) builder.exclude(selector);
    const results = await builder.analyze();
    await testInfo.attach('axe-results.json', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
    });

    const blocking = results.violations.filter((item) => BLOCKING_IMPACTS.has(item.impact ?? ''));
    const warnings = results.violations.filter((item) => !BLOCKING_IMPACTS.has(item.impact ?? ''));

    console.log(
        `[a11y] ${screen}: правил проверено ${results.passes.length + results.violations.length}, ` +
            `серьёзных нарушений ${blocking.length}, предупреждений ${warnings.length}` +
            (results.incomplete.length ? `, требуют ручной проверки ${results.incomplete.length}` : ''),
    );
    if (warnings.length) {
        console.log(`[a11y] ${screen}: предупреждения (moderate и minor), тест не валят:`);
        for (const item of warnings) console.log(`  - ${describeViolation(item)}`);
    }

    expect(blocking.map(describeViolation), `Серьёзные нарушения доступности на экране «${screen}»`).toEqual([]);
}

// ---------------------------------------------------------------- шаги сценария клиента

const NEED = 'Нужно 3 млн на закупку товара к сезону, верну за 2 года';
const PRODUCT = 'Кредит на развитие бизнеса';
const CONSENTS = [
    'Согласие на запрос кредитной истории в бюро кредитных историй',
    'Согласие на обработку персональных данных',
];

/** Шаг 1 «Подбор продукта»: описание задачи → распознанные параметры и карточки продуктов. */
async function describeNeed(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Подобрать кредит' }).first().click();
    await expect(page).toHaveURL(/\/client\/new/);
    await page.locator('textarea').first().fill(NEED);
    await page.getByRole('button', { name: 'Подобрать по описанию' }).click();
    await expect(page.getByText(/^Распознали:/)).toBeVisible();
    await expect(page.getByRole('heading', { name: PRODUCT, exact: true })).toBeVisible();
}

/** Выбор продукта → шаг 2 «Данные заявки». */
async function pickProduct(page: Page): Promise<void> {
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: PRODUCT, exact: true }) });
    await card.getByRole('button', { name: 'Оформить заявку' }).click();
    await expect(page.getByRole('heading', { name: 'О кредите' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Компания' })).toBeVisible();
}

/** Шаг 3 «Проверка и отправка». */
async function goToReview(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByRole('heading', { name: 'Проверьте заявку' })).toBeVisible();
}

/** Согласия и отправка → страница заявки, автоодобрение конвейером. */
async function submitAndWaitForOffer(page: Page): Promise<void> {
    for (const consent of CONSENTS) {
        // Как пользователь: нажатием на подпись (поверх нативного поля лежит декоративный элемент)
        await page.getByText(consent, { exact: true }).click();
        await expect(page.getByRole('checkbox', { name: consent })).toBeChecked();
    }
    await page.getByRole('button', { name: 'Отправить заявку' }).click();
    await expect(page).toHaveURL(/\/client\/applications\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name: 'Кредит одобрен' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Варианты условий' })).toBeVisible();
    await expect(page.getByText('Что повлияло на условия')).toBeVisible();
}

/** Принятие предложения и подписание договора паролем от кабинета → экран «Кредит выдан». */
async function acceptAndSign(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Принять предложение' }).click();
    await page.getByRole('button', { name: 'Подписать договор' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="password"]').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Подписать', exact: true }).click();
    await expect(page.getByText('Кредит выдан').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Остаток' })).toBeVisible();
    await expect(page.getByText('Ближайший платёж')).toBeVisible();
}

// ---------------------------------------------------------------- экраны

test.describe('Доступность: вход', () => {
    test('экран входа', async ({ request, page }, testInfo) => {
        await resetDemo({ request, page });
        await page.goto('/login');
        await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
        await checkA11y(page, 'Вход', testInfo);
    });
});

test.describe('Доступность: кабинет клиента (veter)', () => {
    test.beforeEach(async ({ request, page }) => {
        await resetDemo({ request, page });
        await login(page, 'veter');
        await expect(page.getByRole('heading', { level: 1 })).toContainText('Добрый день');
    });

    test('главная', async ({ page }, testInfo) => {
        await expect(page.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Компания' })).toBeVisible();
        await checkA11y(page, 'Клиент: главная', testInfo);
    });

    test('новая заявка, шаг 1: подбор по описанию', async ({ page }, testInfo) => {
        await describeNeed(page);
        await checkA11y(page, 'Клиент: новая заявка, шаг 1 «Подбор продукта»', testInfo);
    });

    test('новая заявка, шаг 2: данные заявки', async ({ page }, testInfo) => {
        await describeNeed(page);
        await pickProduct(page);
        await checkA11y(page, 'Клиент: новая заявка, шаг 2 «Данные заявки»', testInfo);
    });

    test('новая заявка, шаг 3: проверка и отправка', async ({ page }, testInfo) => {
        await describeNeed(page);
        await pickProduct(page);
        await goToReview(page);
        await checkA11y(page, 'Клиент: новая заявка, шаг 3 «Проверка и отправка»', testInfo);
    });

    test('страница заявки после автоодобрения', async ({ page }, testInfo) => {
        await describeNeed(page);
        await pickProduct(page);
        await goToReview(page);
        await submitAndWaitForOffer(page);
        await checkA11y(page, 'Клиент: заявка одобрена', testInfo);
    });

    test('страница заявки после принятия и подписания: кредит выдан', async ({ page }, testInfo) => {
        await describeNeed(page);
        await pickProduct(page);
        await goToReview(page);
        await submitAndWaitForOffer(page);
        await acceptAndSign(page);
        await checkA11y(page, 'Клиент: кредит выдан', testInfo);
    });
});

test.describe('Доступность: рабочее место аналитика (analyst)', () => {
    const COMPANY = 'Гранд Девелопмент';

    /** Из очереди в досье заявки под залог — она всегда на ручном рассмотрении. */
    async function openDossier(page: Page): Promise<void> {
        await page.getByRole('row', { name: new RegExp(COMPANY) }).click();
        await expect(page.getByRole('heading', { name: `ООО «${COMPANY}»` })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Решение по заявке' })).toBeVisible();
    }

    /** Заголовок вкладки досье (компонент Tabs дизайн-системы). */
    const dossierTab = (page: Page, title: string) => page.locator('.bank-tabs').getByText(title, { exact: true });

    test.beforeEach(async ({ request, page }) => {
        await resetDemo({ request, page });
        await login(page, 'analyst');
        await expect(page.getByRole('heading', { level: 1, name: 'Очередь заявок' })).toBeVisible();
    });

    test('очередь заявок', async ({ page }, testInfo) => {
        await expect(page.getByRole('row', { name: new RegExp(COMPANY) })).toBeVisible();
        await expect(page.getByText(/^Показано заявок:/)).toBeVisible();
        await checkA11y(page, 'Аналитик: очередь заявок', testInfo);
    });

    test('досье, вкладка «Сводка»', async ({ page }, testInfo) => {
        await openDossier(page);
        await expect(page.getByText('Заявка и компания')).toBeVisible();
        await checkA11y(page, 'Аналитик: досье, вкладка «Сводка»', testInfo);
    });

    test('досье, вкладка «Источники»', async ({ page }, testInfo) => {
        await openDossier(page);
        await dossierTab(page, 'Источники').click();
        await expect(page).toHaveURL(/tab=sources/);
        await expect(page.getByText('Шаги проверки')).toBeVisible();
        await checkA11y(page, 'Аналитик: досье, вкладка «Источники»', testInfo);
    });

    test('досье, вкладка «Скоринг»', async ({ page }, testInfo) => {
        await openDossier(page);
        await dossierTab(page, 'Скоринг').click();
        await expect(page).toHaveURL(/tab=scoring/);
        await expect(page.getByText(/Оценка риска|Скоринг ещё не выполнен/)).toBeVisible();
        await checkA11y(page, 'Аналитик: досье, вкладка «Скоринг»', testInfo);
    });

    test('показатели', async ({ page }, testInfo) => {
        await page.goto('/bank/metrics');
        await expect(page.getByRole('heading', { level: 1, name: 'Показатели конвейера' })).toBeVisible();
        await expect(page.getByText('Подано заявок', { exact: true })).toBeVisible();
        await expect(page.getByText('Заявки по дням')).toBeVisible();
        await checkA11y(page, 'Аналитик: показатели', testInfo);
    });

    test('журнал действий', async ({ page }, testInfo) => {
        await page.goto('/bank/audit');
        await expect(page.getByRole('heading', { level: 1, name: 'Журнал действий' })).toBeVisible();
        await expect(page.getByText(/^Записей: \d+/)).toBeVisible();
        await checkA11y(page, 'Аналитик: журнал действий', testInfo);
    });
});

test.describe('Доступность: администратор (admin)', () => {
    test.beforeEach(async ({ request, page }) => {
        await resetDemo({ request, page });
        await login(page, 'admin');
        await expect(page.getByRole('heading', { level: 1, name: 'Очередь заявок' })).toBeVisible();
    });

    test('конвейер и сбои', async ({ page }, testInfo) => {
        await page.goto('/bank/pipeline');
        await expect(page.getByRole('heading', { level: 1, name: 'Конвейер и сбои' })).toBeVisible();
        // Таблица внешних систем с переключателями режимов видна только администратору
        await expect(page.getByRole('columnheader', { name: 'Переключить' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Сбросить демо-данные' })).toBeVisible();
        await expect(page.getByText(/Конвейер работает штатно|Следующая попытка/)).toBeVisible();
        await checkA11y(page, 'Администратор: конвейер и сбои', testInfo);
    });
});
