import { ButtonDesktop } from '@alfalab/core-components/button/desktop';
import { Typography } from '@alfalab/core-components/typography';
import { CheckmarkCircleMIcon } from '@alfalab/icons-glyph/CheckmarkCircleMIcon';
import { ChevronDownMIcon } from '@alfalab/icons-glyph/ChevronDownMIcon';
import { CrossCircleMIcon } from '@alfalab/icons-glyph/CrossCircleMIcon';
import { useState } from 'react';

import { useCompany, useProducts } from '../../api/hooks';
import type { Product, Purpose } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge } from '../../components/ui';
// Правила подбора — те же, что на сервере (backend/app/domain/catalog.py и policy.py): их порт для демо-версии
import { PURPOSE_PRODUCTS, productTerms } from '../../demo/engine/catalog';
import { eligibilityIssues } from '../../demo/engine/policy';
import { months, num, percent, plural, shortAmount } from '../../utils/format';

/** Задачи для подсказки «что подходит». «Запуск бизнеса» — не цель кредита, а возраст бизнеса: только STARTUP. */
const GOALS: { key: string; title: string; purpose: Purpose | null }[] = [
    { key: 'stock', title: 'Закупка товара', purpose: 'WORKING_CAPITAL' },
    { key: 'equipment', title: 'Оборудование', purpose: 'EQUIPMENT' },
    { key: 'gap', title: 'Кассовый разрыв', purpose: 'CASH_GAP' },
    { key: 'expansion', title: 'Расширение', purpose: 'EXPANSION' },
    { key: 'start', title: 'Запуск бизнеса', purpose: null },
];

const goalProducts = (purpose: Purpose | null): string[] => (purpose ? PURPOSE_PRODUCTS[purpose] : ['STARTUP']);

/**
 * Описание продуктов простыми словами. Цифр здесь нет: суммы, сроки и ставки берутся из каталога (/api/products),
 * иначе при смене ключевой ставки или условий страница разойдётся с расчётом.
 */
const GUIDE: Record<
    string,
    { forWhat: string; fits: string[]; notFits: string[]; pros: string[]; cons: string[]; who: string }
> = {
    GROWTH: {
        forWhat: 'Закупки, новая точка, оборудование — крупная сумма без залога',
        fits: [
            'Нужна крупная сумма на развитие',
            'Готовы возвращать равными платежами несколько лет',
            'Бизнесу больше года',
        ],
        notFits: ['Деньги нужны на несколько недель — переплатите за лишний срок', 'Нужна небольшая сумма'],
        pros: ['Без залога', 'Долгий срок — платёж ниже', 'Подходит для разных задач развития'],
        cons: ['Ставка выше, чем у кредита под залог', 'Есть минимальная сумма'],
        who: 'Бизнесу от года на развитие',
    },
    EXPRESS: {
        forWhat: 'Небольшая сумма на текущие нужды — быстро и без залога',
        fits: ['Нужна небольшая сумма', 'Не хотите оформлять залог', 'Важна скорость решения'],
        notFits: ['Нужна крупная сумма — лимит ниже, чем у других кредитов', 'Хотите вернуть за много лет'],
        pros: [
            'Без залога и лишних документов',
            'Небольшая минимальная сумма',
            'Типовые заявки решаются автоматически',
        ],
        cons: ['Ставка выше, чем у кредита на развитие', 'Срок короче'],
        who: 'Текущие нужды, небольшие суммы',
    },
    SECURED: {
        forWhat: 'Крупные вложения под залог — по самой низкой ставке',
        fits: [
            'Нужна крупная сумма на годы',
            'Есть недвижимость, транспорт или оборудование для залога',
            'Важна низкая ставка',
        ],
        notFits: ['Нечего оставить в залог', 'Деньги нужны срочно — заявку рассматривает аналитик'],
        pros: [
            'Самая низкая ставка в каталоге',
            'Самый долгий срок и самая большая сумма',
            'В залог можно оставить покупку',
        ],
        cons: ['Нужен залог — дают часть его стоимости', 'Решение принимает аналитик, а не автоматика'],
        who: 'Крупные проекты с залогом',
    },
    OVERDRAFT: {
        forWhat: 'Закрыть кассовый разрыв на дни и недели',
        fits: [
            'Покупатели платят с задержкой, а поставщикам — сейчас',
            'Разрывы короткие и повторяются',
            'Счёт в банке открыт давно, поступления регулярные',
        ],
        notFits: ['Крупная разовая закупка с возвратом за несколько лет', 'Счёт в банке открыт недавно'],
        pros: [
            'Проценты только за дни, когда пользуетесь деньгами',
            'Лимит на счёте — не нужно оформлять каждый раз',
            'Без залога',
        ],
        cons: ['Лимит зависит от поступлений на счёт', 'Действует год, потом лимит пересматривают'],
        who: 'Короткие кассовые разрывы',
    },
    CREDIT_LINE: {
        forWhat: 'Регулярные закупки: оформляете один раз, берёте частями',
        fits: [
            'Закупаетесь регулярно и суммы меняются',
            'Бизнесу больше года',
            'Нужны деньги несколько раз за год-два',
        ],
        notFits: ['Нужны деньги один раз на большую покупку', 'Хотите вернуть за много лет'],
        pros: ['Проценты только на использованную часть', 'Оформляете один раз', 'Большой лимит'],
        cons: ['Срок короче, чем у кредита на развитие', 'Есть минимальная сумма'],
        who: 'Регулярные закупки и оборот',
    },
    STARTUP: {
        forWhat: 'Первые деньги для бизнеса младше года',
        fits: ['Бизнесу меньше года', 'Нет отчётности и кредитной истории', 'Нужна небольшая сумма на старт'],
        notFits: ['Бизнесу больше года — есть продукты дешевле', 'Нужна крупная сумма'],
        pros: ['Доступен без истории бизнеса', 'Без залога', 'Небольшая минимальная сумма'],
        cons: ['Самая высокая ставка в каталоге', 'Небольшой лимит'],
        who: 'Бизнес младше года',
    },
};

function terms(product: Product): string {
    return product.min_term === product.max_term
        ? months(product.min_term)
        : `${months(product.min_term)} – ${months(product.max_term)}`;
}

function decision(product: Product): string {
    if (productTerms(product.code)?.always_manual) return 'Решает аналитик';
    return product.auto_limit ? `Автоматически до ${shortAmount(num(product.auto_limit))}` : 'Решает аналитик';
}

/**
 * Страница «Продукты»: что есть у банка и что подходит под задачу. Открыта гостю и клиенту. Вошедшему клиенту
 * недоступные продукты помечены причиной — по тем же правилам, что в подборе.
 */
export function ProductsPage({ onCalculate }: { onCalculate: (path: string) => void }) {
    const { user } = useAuth();
    const isClient = user?.role === 'CLIENT';
    const { data: products } = useProducts();
    const { data: company } = useCompany(isClient);
    const [goal, setGoal] = useState<string | null>(null);

    const selected = GOALS.find((item) => item.key === goal) ?? null;
    const matched = selected ? new Set(goalProducts(selected.purpose)) : null;
    const issuesFor = (product: Product): string[] =>
        company
            ? eligibilityIssues(
                  {
                      ...product,
                      min_amount: num(product.min_amount),
                      max_amount: num(product.max_amount),
                      base_rate: num(product.base_rate),
                      auto_limit: product.auto_limit === null ? null : num(product.auto_limit),
                      always_manual: false,
                  },
                  {
                      business_months: company.business_months,
                      is_bank_client: company.is_bank_client,
                      account_months: company.account_months ?? 0,
                  },
              ).map((issue) => issue.text)
            : [];
    const available = products?.filter((product) => issuesFor(product).length === 0).length ?? 0;

    // В подбор — с целью, под которую продукт подходит, и с суммой и сроком в его пределах
    const calculate = (product: Product) => {
        const purpose =
            (selected?.purpose && PURPOSE_PRODUCTS[selected.purpose].includes(product.code)
                ? selected.purpose
                : null) ??
            (Object.keys(PURPOSE_PRODUCTS) as Purpose[]).find((code) =>
                PURPOSE_PRODUCTS[code].includes(product.code),
            ) ??
            'WORKING_CAPITAL';
        const amount = Math.min(Math.max(3_000_000, num(product.min_amount)), num(product.max_amount));
        const term = Math.min(Math.max(24, product.min_term), product.max_term);
        onCalculate(`/client/new?purpose=${purpose}&amount=${amount}&term=${term}`);
    };

    return (
        <>
            <section className='login__brand'>
                <div className='login__inner stack-16'>
                    <Typography.TitleResponsive
                        tag='h1'
                        view='xlarge'
                        font='system'
                        weight='bold'
                        color='primary-inverted'
                    >
                        Какой продукт нужен вашему бизнесу?
                    </Typography.TitleResponsive>
                    <Typography.Text view='primary-large' color='primary-inverted' tag='p'>
                        Что есть у банка, кому что подходит и сколько стоит — без рекламы и мелкого шрифта
                    </Typography.Text>
                </div>
            </section>

            <section className='login__sheet'>
                <div className='login__inner landing-sections'>
                    <section className='stack-16'>
                        <Typography.Text view='primary-medium' color='secondary' tag='p'>
                            Выберите задачу — подсветим подходящие продукты
                        </Typography.Text>
                        <div className='chips' role='group' aria-label='Задача бизнеса'>
                            {GOALS.map((item) => (
                                <button
                                    key={item.key}
                                    type='button'
                                    className={`chip${goal === item.key ? ' chip--active' : ''}`}
                                    aria-pressed={goal === item.key}
                                    onClick={() => setGoal(goal === item.key ? null : item.key)}
                                >
                                    {item.title}
                                </button>
                            ))}
                        </div>
                        {company && products && (
                            <Typography.Text view='primary-medium' tag='p'>
                                Для {company.name} {plural(available, 'доступен', 'доступно', 'доступно')} {available}{' '}
                                из {products.length} продуктов
                            </Typography.Text>
                        )}
                    </section>

                    <div className='products-grid'>
                        {products?.map((product) => {
                            const guide = GUIDE[product.code];
                            const issues = issuesFor(product);
                            const state = matched
                                ? matched.has(product.code)
                                    ? ' products-card--match'
                                    : ' products-card--dim'
                                : '';
                            return (
                                <article key={product.code} className={`products-card${state}`}>
                                    <div className='stack-8'>
                                        <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                                            {product.name}
                                        </Typography.Title>
                                        {guide && (
                                            <Typography.Text view='primary-medium' color='secondary' tag='p'>
                                                {guide.forWhat}
                                            </Typography.Text>
                                        )}
                                    </div>
                                    <dl className='products-card__figures'>
                                        <div>
                                            <dt>Ставка</dt>
                                            <dd>от {percent(product.base_rate)}</dd>
                                        </div>
                                        <div>
                                            <dt>{product.kind === 'LOAN' ? 'Сумма' : 'Лимит'}</dt>
                                            <dd>
                                                {shortAmount(num(product.min_amount))} –{' '}
                                                {shortAmount(num(product.max_amount))}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt>Срок</dt>
                                            <dd>{terms(product)}</dd>
                                        </div>
                                    </dl>
                                    {issues.length > 0 && (
                                        <div>
                                            <Badge color='orange'>Сейчас недоступен: {issues.join('; ')}</Badge>
                                        </div>
                                    )}
                                    {guide && (
                                        // Подробности свёрнуты, чтобы карточка не пугала объёмом текста
                                        <details className='products-card__more'>
                                            <summary>
                                                Подробнее: кому подходит, плюсы и минусы
                                                <ChevronDownMIcon width={20} height={20} aria-hidden={true} />
                                            </summary>
                                            <div className='products-card__lists'>
                                                <GuideList title='Подходит, если' items={guide.fits} good={true} />
                                                <GuideList
                                                    title='Не подходит, если'
                                                    items={guide.notFits}
                                                    good={false}
                                                />
                                                <GuideList title='Плюсы' items={guide.pros} good={true} />
                                                <GuideList title='Минусы' items={guide.cons} good={false} />
                                            </div>
                                        </details>
                                    )}
                                    <div className='products-card__action'>
                                        <ButtonDesktop view='secondary' size={40} onClick={() => calculate(product)}>
                                            Рассчитать
                                        </ButtonDesktop>
                                    </div>
                                </article>
                            );
                        })}
                    </div>

                    <section className='stack'>
                        <Typography.Title tag='h2' view='medium' font='system' weight='bold'>
                            Сравнение продуктов
                        </Typography.Title>
                        <div className='table-wrap'>
                            <table className='simple products-table'>
                                <thead>
                                    <tr>
                                        <th>Продукт</th>
                                        <th>Ставка</th>
                                        <th>Сумма</th>
                                        <th>Срок</th>
                                        <th>Залог</th>
                                        <th>Решение</th>
                                        <th>Кому подходит</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {products?.map((product) => (
                                        <tr key={product.code}>
                                            <td>{product.name}</td>
                                            <td className='nowrap'>от {percent(product.base_rate)}</td>
                                            <td className='nowrap'>
                                                {shortAmount(num(product.min_amount))} –{' '}
                                                {shortAmount(num(product.max_amount))}
                                            </td>
                                            <td className='nowrap'>{terms(product)}</td>
                                            <td>{product.collateral_required ? 'Нужен' : 'Не нужен'}</td>
                                            <td>{decision(product)}</td>
                                            <td>{GUIDE[product.code]?.who}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <Typography.Text view='primary-small' color='secondary' tag='p'>
                            Ставка — базовая, к ней прибавляется надбавка за риск. Точные условия — в предложении по
                            заявке.
                        </Typography.Text>
                    </section>
                </div>
            </section>
        </>
    );
}

function GuideList({ title, items, good }: { title: string; items: string[]; good: boolean }) {
    const Icon = good ? CheckmarkCircleMIcon : CrossCircleMIcon;
    return (
        <div className='stack-8'>
            <Typography.Text view='primary-small' weight='bold' tag='div'>
                {title}
            </Typography.Text>
            <ul className={`products-card__list${good ? '' : ' products-card__list--bad'}`}>
                {items.map((item) => (
                    <li key={item}>
                        <Icon width={18} height={18} aria-hidden={true} />
                        <span>{item}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
