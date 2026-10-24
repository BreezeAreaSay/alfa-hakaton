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
            { label: 'Справочный центр', href: 'https://alfabank.ru/help/t/corp/' },
            { label: 'Блог', href: 'https://alfabank.ru/help/articles/sme/' },
            { label: 'Безопасность', href: 'https://alfabank.ru/everyday/online/alfaclick/security/' },
            { label: 'Иностранным гражданам', href: 'https://alfabank.ru/everyday/non-residents/' },
            { label: 'Карта сайта', href: 'https://alfabank.ru/sitemap/' },
            { label: 'График работы', href: 'https://alfabank.ru/sme/schedule/' },
        ],
    },
];

/**
 * Подвал как на alfabank.ru для бизнеса: ссылки ведут на сайты Альфа-Банка и открываются в новой вкладке.
 * Без телефонов, мессенджеров и мобильного приложения: по ТЗ (стр. 11) сценарий проходит только внутри продукта.
 */
export function AppFooter() {
    return (
        <footer className='footer'>
            <div className='footer__inner'>
                <div className='footer__grid'>
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

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
    return (
        <a href={href} target='_blank' rel='noreferrer'>
            {children}
        </a>
    );
}
