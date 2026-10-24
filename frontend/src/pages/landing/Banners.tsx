import { ButtonDesktop } from '@alfalab/core-components/button/desktop';
import { Typography } from '@alfalab/core-components/typography';
import { ChartColumnThreeAscMIcon } from '@alfalab/icons-glyph/ChartColumnThreeAscMIcon';
import { ChartLineAscMIcon } from '@alfalab/icons-glyph/ChartLineAscMIcon';
import { CheckmarkCircleMIcon } from '@alfalab/icons-glyph/CheckmarkCircleMIcon';
import { ClockMIcon } from '@alfalab/icons-glyph/ClockMIcon';
import { DocumentCheckmarkMIcon } from '@alfalab/icons-glyph/DocumentCheckmarkMIcon';
import { EyeMIcon } from '@alfalab/icons-glyph/EyeMIcon';
import { HouseMIcon } from '@alfalab/icons-glyph/HouseMIcon';
import { LightningMIcon } from '@alfalab/icons-glyph/LightningMIcon';
import { PenNibMIcon } from '@alfalab/icons-glyph/PenNibMIcon';
import { PercentMIcon } from '@alfalab/icons-glyph/PercentMIcon';
import { RepeatMIcon } from '@alfalab/icons-glyph/RepeatMIcon';
import { RocketMIcon } from '@alfalab/icons-glyph/RocketMIcon';
import { RubMIcon } from '@alfalab/icons-glyph/RubMIcon';
import { StarMIcon } from '@alfalab/icons-glyph/StarMIcon';
import { WalletMIcon } from '@alfalab/icons-glyph/WalletMIcon';
import type { ComponentType, SVGProps } from 'react';

import { useProducts } from '../../api/hooks';
import type { Product } from '../../api/types';
import { months, num, percent, shortAmount } from '../../utils/format';

import './landing.css';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
type Tone = 'red' | 'orange' | 'green' | 'teal' | 'blue' | 'violet' | 'silver';

/** Глянцевый шар с иконкой — иллюстрации нарисованы CSS, без графики банка (её лицензия закрыта). */
function Orb({
    icon: Glyph,
    tone,
    size,
    className = '',
}: {
    icon: Icon;
    tone: Tone;
    size: number;
    className?: string;
}) {
    return (
        <span className={`landing-orb landing-orb--${tone} ${className}`} style={{ width: size, height: size }}>
            <Glyph width={Math.round(size * 0.42)} height={Math.round(size * 0.42)} />
        </span>
    );
}

function Sparkle({ size, className }: { size: number; className: string }) {
    return <span className={`landing-sparkle ${className}`} style={{ width: size, height: size }} />;
}

/** Иллюстрация справа в шторке: проценты, рубль и звезда. */
export function HeroArt() {
    return (
        <div className='landing-hero__art' aria-hidden={true}>
            <Orb icon={PercentMIcon} tone='red' size={168} className='landing-hero__orb landing-hero__orb--main' />
            <Orb icon={RubMIcon} tone='silver' size={112} className='landing-hero__orb landing-hero__orb--rub' />
            <Orb icon={StarMIcon} tone='violet' size={84} className='landing-hero__orb landing-hero__orb--star' />
            <Sparkle size={64} className='landing-hero__sparkle landing-hero__sparkle--top' />
            <Sparkle size={44} className='landing-hero__sparkle landing-hero__sparkle--bottom' />
        </div>
    );
}

const PRODUCT_ART: Record<string, { icon: Icon; tone: Tone }> = {
    GROWTH: { icon: ChartLineAscMIcon, tone: 'green' },
    EXPRESS: { icon: LightningMIcon, tone: 'orange' },
    SECURED: { icon: HouseMIcon, tone: 'blue' },
    OVERDRAFT: { icon: WalletMIcon, tone: 'violet' },
    CREDIT_LINE: { icon: RepeatMIcon, tone: 'teal' },
    STARTUP: { icon: RocketMIcon, tone: 'red' },
};

/** «до 5 лет», «до 3 лет», «до 1 года» — после «до» нужен родительный падеж, а months() даёт именительный. */
function upToTerm(term: number): string {
    if (term % 12) return `до ${months(term)}`;
    const years = term / 12;
    return `до ${years} ${years % 10 === 1 && years % 100 !== 11 ? 'года' : 'лет'}`;
}

function productFacts(product: Product): string[] {
    const revolving = product.kind !== 'LOAN';
    const amount = `${revolving ? 'лимит до' : 'до'} ${shortAmount(num(product.max_amount))}`;
    const term = product.kind === 'OVERDRAFT' && product.max_term === 12 ? 'на год' : upToTerm(product.max_term);
    // «Кредит под залог», «Экспресс-кредит без залога» — про залог уже сказано в названии
    if (/залог/i.test(product.name)) return [amount, term];
    return [amount, term, product.collateral_required ? 'под залог' : 'без залога'];
}

function ProductCard({ product, onStart }: { product: Product; onStart: () => void }) {
    const art = PRODUCT_ART[product.code] ?? { icon: PercentMIcon, tone: 'red' };
    return (
        <button type='button' className='landing-product' onClick={onStart}>
            <span className='landing-product__rate'>от {percent(product.base_rate)}</span>
            <span className='landing-product__name'>{product.name}</span>
            <span className='landing-product__facts'>{productFacts(product).join(' · ')}</span>
            <span className='landing-product__text'>{product.description}</span>
            <Orb icon={art.icon} tone={art.tone} size={104} className='landing-product__art' />
        </button>
    );
}

const ONLINE = [
    { icon: ClockMIcon, text: 'Решение за несколько минут — типовые заявки банк проверяет автоматически' },
    { icon: DocumentCheckmarkMIcon, text: 'Данные компании подтянем из ЕГРЮЛ — заполнять почти нечего' },
    { icon: EyeMIcon, text: 'Статус и шаги проверки видно в кабинете в реальном времени' },
    { icon: PenNibMIcon, text: 'Договор, подписание и выдача — прямо в кабинете' },
];

/**
 * Чёрный блок с продуктами из каталога (GET /api/products открыт без входа) и карточкой «Кредит онлайн».
 * Ставки на карточках — базовые: к ним прибавляется надбавка за класс риска, поэтому «от».
 */
export function ProductsBanner({ onStart }: { onStart: () => void }) {
    const { data: products } = useProducts();
    const minRate = products?.length ? Math.min(...products.map((product) => num(product.base_rate))) : null;

    return (
        <section className='landing-dark'>
            <div className='stack-8'>
                <Typography.Title tag='h2' view='medium' font='system' weight='bold' color='primary-inverted'>
                    {/* неразрывные пробелы: строка не начинается с тире, «от» не отрывается от ставки */}
                    {minRate === null ? 'Кредиты для бизнеса' : `Кредиты для бизнеса — ставка от ${percent(minRate)}`}
                </Typography.Title>
                <Typography.Text view='primary-medium' color='secondary-inverted' tag='p'>
                    Ставки привязаны к ключевой ставке Банка России. Платёж и переплату покажем ещё до заявки.
                </Typography.Text>
            </div>

            <div className='landing-products'>
                {products?.map((product) => (
                    <ProductCard key={product.code} product={product} onStart={onStart} />
                ))}
            </div>

            <div className='landing-feature'>
                <div className='landing-feature__body'>
                    <Typography.Title tag='h3' view='small' font='system' weight='bold' color='primary-inverted'>
                        Кредит онлайн — без визитов в банк
                    </Typography.Title>
                    <ul className='landing-feature__list'>
                        {ONLINE.map(({ icon: Glyph, text }) => (
                            <li key={text}>
                                <Glyph width={24} height={24} aria-hidden={true} />
                                <span>{text}</span>
                            </li>
                        ))}
                    </ul>
                    <div>
                        <ButtonDesktop view='primary' size={48} onClick={onStart}>
                            Подобрать кредит
                        </ButtonDesktop>
                    </div>
                </div>
                <div className='landing-feature__art' aria-hidden={true}>
                    <Orb icon={PenNibMIcon} tone='red' size={148} className='landing-feature__orb--main' />
                    <Orb icon={DocumentCheckmarkMIcon} tone='blue' size={96} className='landing-feature__orb--doc' />
                    <Orb icon={CheckmarkCircleMIcon} tone='green' size={68} className='landing-feature__orb--ok' />
                    <Sparkle size={40} className='landing-feature__sparkle' />
                </div>
            </div>
        </section>
    );
}

const PROMOS: { title: string; text: string; action: string; icon: Icon; tone: Tone }[] = [
    {
        title: 'Предложение ещё до заявки',
        text: 'Войдите в кабинет — по данным компании покажем, какой кредит банк готов предложить, с суммой и платежом.',
        action: 'Узнать свой лимит',
        icon: StarMIcon,
        tone: 'orange',
    },
    {
        title: 'Кассовый разрыв — заранее',
        text: 'Загрузите выписку из 1С или CSV: покажем деньги на три месяца вперёд и подскажем лимит овердрафта.',
        action: 'Построить прогноз',
        icon: ChartColumnThreeAscMIcon,
        tone: 'violet',
    },
    {
        title: 'Не только «да» или «нет»',
        text: 'Если запрошенные условия не подходят, банк предложит другие — больший срок или меньшую сумму — и объяснит почему.',
        action: 'Подобрать кредит',
        icon: CheckmarkCircleMIcon,
        tone: 'green',
    },
];

/** Роли из ТЗ (стр. 5): у каждой свой этап пути — решает, следит за заявкой, готовит данные. */
const AUDIENCE: { title: string; who: string; quote: string; points: string[]; icon: Icon; tone: Tone }[] = [
    {
        title: 'Собственнику',
        who: 'Владелец бизнеса или ИП',
        quote: 'Хочу оформить кредит, не отвлекаясь от бизнеса',
        points: [
            'Продукт под задачу бизнеса, а не по названию',
            'Платёж и переплата — ещё до заявки',
            'Если банк не готов дать запрошенное — объяснит почему и предложит другие условия',
        ],
        icon: StarMIcon,
        tone: 'orange',
    },
    {
        title: 'Руководителю',
        who: 'Генеральный директор или представитель по доверенности',
        quote: 'Хочу видеть, что с заявкой, и не звонить в банк',
        points: [
            'Заявка онлайн — данные компании заполнятся сами',
            'Каждый шаг проверки виден на экране',
            'Подпись договора и выдача — без визита в банк',
        ],
        icon: PenNibMIcon,
        tone: 'red',
    },
    {
        title: 'Финансисту',
        who: 'Финансовый директор, бухгалтер, сотрудник по финансированию',
        quote: 'Не хочу собирать справки и вводить одно и то же по три раза',
        points: [
            'Реквизиты и отчётность подтянем из реестров',
            'Запросы банка и документы — в одном месте',
            'По выписке из 1С — прогноз кассового разрыва на три месяца',
        ],
        icon: ChartColumnThreeAscMIcon,
        tone: 'violet',
    },
];

const TERMS = ['ИП и ООО', 'Счёт в Альфа-Банке', 'Бизнесу от 3 месяцев'];

/** Для кого кабинет: малый и микробизнес, роли из ТЗ и условия — те же, что в ответах на вопросы. */
export function AudienceSection() {
    return (
        <section className='stack'>
            <div className='stack-8'>
                <Typography.Title tag='h2' view='medium' font='system' weight='bold'>
                    Кому подойдёт кабинет
                </Typography.Title>
                <Typography.Text view='primary-medium' color='secondary' tag='p'>
                    Малому и микробизнесу — ИП и компаниям, у которых уже есть счёт в Альфа-Банке
                </Typography.Text>
            </div>
            <ul className='login__steps'>
                {AUDIENCE.map((role) => (
                    <li key={role.title} className='login__step landing-audience__card'>
                        <Orb icon={role.icon} tone={role.tone} size={56} />
                        <div>
                            <Typography.Text view='primary-medium' weight='bold' tag='div'>
                                {role.title}
                            </Typography.Text>
                            <Typography.Text view='primary-small' color='secondary' tag='div'>
                                {role.who}
                            </Typography.Text>
                        </div>
                        <q className='landing-audience__quote'>{role.quote}</q>
                        <ul className='landing-audience__points'>
                            {role.points.map((point) => (
                                <li key={point}>
                                    <CheckmarkCircleMIcon width={20} height={20} aria-hidden={true} />
                                    <span>{point}</span>
                                </li>
                            ))}
                        </ul>
                    </li>
                ))}
            </ul>
            <div className='stack-8'>
                <ul className='landing-audience__terms'>
                    {TERMS.map((term) => (
                        <li key={term}>
                            <CheckmarkCircleMIcon width={20} height={20} aria-hidden={true} />
                            <span>{term}</span>
                        </li>
                    ))}
                </ul>
                <Typography.Text view='primary-small' color='secondary' tag='p'>
                    Не подойдёт тем, кто только планирует открыть бизнес, и компаниям в ликвидации.
                </Typography.Text>
            </div>
        </section>
    );
}

/** Светлые баннеры о возможностях кабинета: всё перечисленное работает в прототипе. */
export function PromoBanners({ onStart }: { onStart: () => void }) {
    return (
        <div className='landing-promos'>
            {PROMOS.map((promo) => (
                <button key={promo.title} type='button' className='landing-promo' onClick={onStart}>
                    <span className='landing-promo__title'>{promo.title}</span>
                    <span className='landing-promo__text'>{promo.text}</span>
                    <span className='landing-promo__action'>{promo.action} →</span>
                    <Orb icon={promo.icon} tone={promo.tone} size={96} className='landing-promo__art' />
                </button>
            ))}
        </div>
    );
}
