import { LocatorLineMIcon } from '@alfalab/icons-glyph/LocatorLineMIcon';
import { AlfaBankLIcon } from '@alfalab/icons-logotype/AlfaBankLIcon';
import { TelegramMIcon } from '@alfalab/icons-logotype/TelegramMIcon';
import { VkMIcon } from '@alfalab/icons-logotype/VkMIcon';
import type { ReactNode } from 'react';

interface FooterLink {
    label: string;
    href: string;
}

// Разделы и адреса — из подвала alfabank.ru для бизнеса
const COLUMNS: { title: string; links: FooterLink[] }[] = [
    {
        title: 'Сервисы',
        links: [
            { label: 'Курсы валют', href: 'https://alfabank.ru/currency/' },
            { label: 'Курсы металлов', href: 'https://alfabank.ru/make-money/investments/metall/' },
            { label: 'Отделения', href: 'https://alfabank.ru/office/' },
            { label: 'Банкоматы', href: 'https://alfabank.ru/atm/' },
            { label: 'Активация карты', href: 'https://online.alfabank.ru/cards-activation/' },
            { label: 'Конструктор сайтов', href: 'https://alfabank.ru/cms/' },
            { label: 'А-Клуб', href: 'https://alfabank.ru/a-club/' },
            { label: 'Акции и предложения', href: 'https://alfabank.ru/retail/promotions/' },
        ],
    },
    {
        title: 'Банк',
        links: [
            { label: 'О банке', href: 'https://alfabank.ru/about/' },
            { label: 'Пресс-служба', href: 'https://alfabank.ru/news/' },
            { label: 'Вакансии', href: 'https://job.alfabank.ru/' },
            { label: 'Реквизиты', href: 'https://alfabank.ru/essential/' },
            { label: 'Тарифы и документы', href: 'https://alfabank.ru/sme/quick/docstariffs/' },
            { label: 'Должникам и взыскателям', href: 'https://alfabank.ru/lp/retail/dolpri/' },
            { label: 'Закупки', href: 'https://alfabank.ru/tenders/' },
        ],
    },
    {
        title: 'Поддержка',
        links: [
            { label: 'Обращение в банк', href: 'https://alfabank.ru/feedback/support/' },
            { label: 'Справочный центр', href: 'https://alfabank.ru/help/t/corp/' },
            { label: 'Блог', href: 'https://alfabank.ru/help/articles/sme/' },
            { label: 'Безопасность', href: 'https://alfabank.ru/everyday/online/alfaclick/security/' },
            { label: 'Иностранным гражданам', href: 'https://alfabank.ru/everyday/non-residents/' },
            { label: 'Карта сайта', href: 'https://alfabank.ru/sitemap/' },
            { label: 'График работы', href: 'https://alfabank.ru/sme/schedule/' },
        ],
    },
];

// Звонок частному клиенту из браузера — через вход Альфа-Банка, как на alfabank.ru
const BROWSER_CALL =
    'https://private.auth.alfabank.ru/passport/cerberus-mini/dashboard/username?response_type=code&client_id=newclick-web&scope=openid%20newclick-web&acr_values=username&non_authorized_user=true&sidepanelid=voip';

/** Подвал как на alfabank.ru для бизнеса: все ссылки ведут на сайты Альфа-Банка и открываются в новой вкладке. */
export function AppFooter() {
    return (
        <footer className='footer'>
            <div className='footer__inner'>
                <div className='footer__grid'>
                    <section>
                        <h2 className='footer__title'>Связь с банком</h2>
                        <dl className='footer__contacts'>
                            <dt>Бизнесу</dt>
                            <dd>
                                <a href='tel:88001007733'>8 800 100 77 33</a>
                            </dd>
                            <dt>Частным лицам</dt>
                            <dd>
                                <ExternalLink href={BROWSER_CALL}>Звонок в банк</ExternalLink>
                            </dd>
                            <dt>Звонок из-за границы</dt>
                            <dd>
                                <a href='tel:+74957888878'>+7 495 788 88 78</a>
                            </dd>
                        </dl>
                    </section>
                    {COLUMNS.map((column) => (
                        <section key={column.title}>
                            <h2 className='footer__title'>{column.title}</h2>
                            <ul className='footer__links'>
                                {column.links.map((link) => (
                                    <li key={link.href}>
                                        <ExternalLink href={link.href}>{link.label}</ExternalLink>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                    <section>
                        <h2 className='footer__title'>Местоположение</h2>
                        <span className='footer__item footer__city'>
                            <LocatorLineMIcon width={16} height={16} aria-hidden={true} />
                            Москва
                        </span>
                    </section>
                    <section>
                        <h2 className='footer__title'>Скачать приложение</h2>
                        <ExternalLink href='https://alfabank.ru/sme/rko/abm/' className='footer__item'>
                            <span className='footer__app-icon'>
                                <AlfaBankLIcon width={11} height={17} aria-hidden={true} />
                            </span>
                            Альфа-Бизнес
                        </ExternalLink>
                    </section>
                    <section>
                        <h2 className='footer__title'>Для иностранных клиентов</h2>
                        <div className='footer__row'>
                            <ExternalLink href='https://alfabank.ru/corporate/china/' className='footer__item'>
                                <ChinaFlag />
                                中文
                            </ExternalLink>
                            <ExternalLink href='https://alfabank.ru/en/' className='footer__item'>
                                <UkFlag />
                                Eng
                            </ExternalLink>
                        </div>
                    </section>
                    <section>
                        <h2 className='footer__title'>Наши соцсети</h2>
                        <div className='footer__row'>
                            <ExternalLink
                                href='https://t.me/AlfaBank'
                                label='Telegram'
                                className='footer__social footer__social--telegram'
                            >
                                <TelegramMIcon aria-hidden={true} />
                            </ExternalLink>
                            <ExternalLink
                                href='https://vk.com/alfabank'
                                label='ВКонтакте'
                                className='footer__social footer__social--vk'
                            >
                                <VkMIcon aria-hidden={true} />
                            </ExternalLink>
                        </div>
                    </section>
                </div>
                {/* Вместо юридического текста alfabank.ru — честное пояснение: это прототип, а не сайт банка */}
                <div className='footer__legal'>
                    <p>
                        Прототип кредитного кабинета для малого и микробизнеса — решение кейса Альфа-Банка на хакатоне
                        «Альфа Будущее». Не является официальным сайтом АО «Альфа-Банк», продукты и ставки не являются
                        офертой.
                    </p>
                    <p>
                        Компании, люди, документы, заявки и финансовые показатели синтетические. Подписание и выдача
                        кредита смоделированы, реальных операций нет.
                    </p>
                </div>
            </div>
        </footer>
    );
}

function ExternalLink({
    href,
    label,
    className,
    children,
}: {
    href: string;
    label?: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <a href={href} className={className} aria-label={label} target='_blank' rel='noreferrer'>
            {children}
        </a>
    );
}

// Флаги — из набора дизайн-системы (@alfalab/core-components, MIT); весь набор весит 265 КБ, поэтому взяты только два
function ChinaFlag() {
    return (
        <svg width='24' height='24' viewBox='0 0 24 24' aria-hidden={true}>
            <path
                fill='#FF4B55'
                d='M22.2 4.1H1.8C.8 4.1 0 5 0 6v12.2q.2 1.6 1.8 1.8h20.4q1.6-.2 1.8-1.8V5.9q-.2-1.7-1.8-1.8'
            />
            <path
                fill='#FFE15A'
                d='m4 6.6.4 1.2h1.2q.4 0 .1.3l-1 .7.4 1.2q0 .3-.3.2l-1-.7-1 .7q-.2.1-.2-.2l.3-1.2-1-.7q-.1-.2.1-.3h1.3l.4-1.2q0-.3.3 0m4.5.3.3.4.5-.2v.1l-.3.4.3.4v.1L8.7 8l-.3.3h-.1v-.5l-.5-.1v-.1l.5-.2v-.5h.1ZM6.8 5.7h.5l.2-.3.2.4.5.1V6l-.4.3v.4s0 .1 0 0l-.4-.2-.4.2h-.1l.2-.5-.4-.4Zm.7 4.7-.2.4-.5-.2s-.1 0 0 .1l.2.4-.3.4s0 .1.1 0h.5l.2.3h.2v-.5l.4-.1V11l-.4-.1v-.5zm1.8-1.1h-.5L8.6 9h-.1l-.1.5h-.5v.2l.4.2-.1.5h.1l.4-.3.4.3v-.1L9 9.7z'
            />
        </svg>
    );
}

function UkFlag() {
    return (
        <svg width='24' height='24' viewBox='0 0 24 24' aria-hidden={true}>
            <path
                fill='#41479B'
                d='M22.2 4.1H1.8C.8 4.1 0 5 0 6v12.2q.2 1.6 1.8 1.8h20.4q1.6-.2 1.8-1.8V5.9q-.2-1.7-1.8-1.8'
            />
            <path
                fill='#F5F5F5'
                d='M24 5.6q-.4-1.3-1.8-1.5h-.5l-7.6 5v-5H9.9v5l-7.6-5h-.5Q.4 4.3 0 5.6L6.6 10H0v4.2h6.6L0 18.4q.5 1.4 1.8 1.5h.5l7.6-5v5h4.2v-5l7.6 5h.5q1.4-.1 1.8-1.5L17.4 14H24V9.9h-6.6z'
            />
            <path fill='#FF4B55' d='M13.2 4.1h-2.4v6.7H0v2.4h10.8V20h2.4v-6.7H24v-2.4H13.2z' />
            <path
                fill='#FF4B55'
                d='m1.2 19.7 8.7-5.6H8.4l-8 5.1q.3.4.8.5m15-5.7h-1.5l8.5 5.6.6-.6zM.2 5.1 7.6 10H9L.7 4.5zM15.6 10l8-5.2q-.3-.4-.8-.6L14.1 10z'
            />
        </svg>
    );
}
