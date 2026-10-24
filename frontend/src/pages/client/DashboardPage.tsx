import { Button } from '@alfalab/core-components/button';
import { Typography } from '@alfalab/core-components/typography';
import { ChevronRightMIcon } from '@alfalab/icons-glyph/ChevronRightMIcon';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApplications, useCompany, usePreliminaryOffers, useProactiveOffers } from '../../api/hooks';
import type { ApplicationListItem, ProactiveOffer } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Empty, ErrorPlate, Loader, SectionTitle, StatusBadge } from '../../components/ui';
import { date, months, percent, rub } from '../../utils/format';
import { CashflowForecast } from '../../components/CashflowForecast';
import { CompanyCard } from './components/CompanyCard';
import { UploadButton } from './components/UploadButton';

export const HOW_IT_WORKS = [
    { title: 'Подберите кредит', text: 'Расскажите, на что нужны деньги, — покажем подходящие продукты и платёж' },
    { title: 'Отправьте заявку', text: 'Данные компании подтянем из ЕГРЮЛ, проверка — в среднем несколько минут' },
    { title: 'Подпишите договор', text: 'Подписание и выдача — прямо в кабинете, без визитов и звонков' },
];

/**
 * Предварительные предложения: что банк готов дать по уже известным данным компании, без заявки и кредитной
 * истории. Одно-два предложения с объяснением; «Скрыть» запоминается в этом браузере.
 */
function ProactiveOffersCard({ companyId }: { companyId: string }) {
    const offers = useProactiveOffers();
    const storageKey = `proactive-hidden:${companyId}`;
    const [hidden, setHidden] = useState(() => {
        try {
            return localStorage.getItem(storageKey) === '1';
        } catch {
            return false;
        }
    });
    const hide = () => {
        setHidden(true);
        try {
            localStorage.setItem(storageKey, '1');
        } catch {
            // приватное окно: предложение просто вернётся при следующем входе
        }
    };
    const data = offers.data;
    if (hidden || !data || data.offers.length === 0) return null;
    return (
        <section className='card card--tight stack-16' aria-label='Предварительные предложения'>
            <SectionTitle
                extra={
                    <Button view='text' size={32} onClick={hide}>
                        Скрыть
                    </Button>
                }
            >
                Вам уже доступно
            </SectionTitle>
            <div className='proactive__grid'>
                {data.offers.map((offer) => (
                    <OfferTile key={offer.product_code} offer={offer} />
                ))}
            </div>
            {data.facts.length > 0 && (
                <ul className='proactive__facts'>
                    {data.facts.map((fact) => (
                        <li key={fact}>{fact}</li>
                    ))}
                </ul>
            )}
            {data.note && (
                <Typography.Text view='primary-small' color='secondary' tag='p'>
                    {data.note}
                </Typography.Text>
            )}
        </section>
    );
}

/** Плитка предварительного предложения: продукт, сумма, условия и переход в заявку с этими параметрами. */
function OfferTile({ offer }: { offer: ProactiveOffer }) {
    const navigate = useNavigate();
    return (
        <div className='tile stack-8'>
            <Typography.Text view='primary-small' color='secondary' tag='div'>
                {offer.product_name}
            </Typography.Text>
            <Typography.Title tag='div' view='small' font='system' weight='bold'>
                до {rub(offer.amount)}
            </Typography.Title>
            <Typography.Text view='primary-small' color='secondary' tag='div'>
                {offer.kind === 'LOAN'
                    ? `${months(offer.term_months)} · от ${percent(offer.rate_from)} годовых · ${rub(offer.monthly_payment)} в месяц`
                    : `от ${percent(offer.rate_from)} годовых · ${rub(offer.monthly_payment)} в месяц при полном использовании лимита`}
            </Typography.Text>
            <div>
                <Button
                    view='secondary'
                    size={40}
                    onClick={() =>
                        navigate(
                            `/client/new?purpose=${offer.purpose}&amount=${offer.amount}&term=${offer.term_months}`,
                        )
                    }
                >
                    Оформить
                </Button>
            </div>
        </div>
    );
}

/**
 * «Сколько одобрят по выписке»: клиент загружает выписку из любого банка и за секунды видит предварительный
 * лимит и прогноз кассового разрыва — без анкеты. Файл не сохраняется, результат живёт, пока открыта страница.
 */
function StatementCheckCard() {
    const check = usePreliminaryOffers();
    const data = check.data;
    return (
        <section className='card card--tight stack-16' aria-label='Предварительный лимит по выписке'>
            <SectionTitle>Сколько одобрят по выписке</SectionTitle>
            <Typography.Text view='primary-small' color='secondary' tag='p'>
                Загрузите выписку по счёту из любого банка в формате 1С или CSV — за несколько секунд покажем
                предварительный лимит и прогноз денежного потока на три месяца. Файл не сохраняется и заявкой не
                становится.{' '}
                <a href={`${import.meta.env.BASE_URL}demo-files/vypiska_smirnova.csv`} download={true}>
                    Тестовая выписка
                </a>
            </Typography.Text>
            <div className='row'>
                <UploadButton accept='.txt,.csv' loading={check.isPending} onFile={(file) => check.mutate(file)}>
                    Загрузить выписку
                </UploadButton>
            </div>
            <ErrorPlate error={check.error} />
            {data && (
                <>
                    {data.offers.length > 0 && (
                        <div className='proactive__grid'>
                            {data.offers.map((offer) => (
                                <OfferTile key={offer.product_code} offer={offer} />
                            ))}
                        </div>
                    )}
                    <ul className='proactive__facts'>
                        {data.facts.map((fact) => (
                            <li key={fact}>{fact}</li>
                        ))}
                    </ul>
                    {data.note && (
                        <Typography.Text view='primary-small' color='secondary' tag='p'>
                            {data.note}
                        </Typography.Text>
                    )}
                    <CashflowForecast forecast={data.statement.forecast} compact={true} />
                </>
            )}
        </section>
    );
}

function greeting(fullName: string | undefined): string {
    const parts = (fullName ?? '').split(' ');
    return parts.length >= 3 ? `${parts[1]} ${parts[2]}` : (fullName ?? '');
}

export function DashboardPage() {
    const { user } = useAuth();
    const navigate = useNavigate();
    const company = useCompany();
    const applications = useApplications();

    const open = (item: ApplicationListItem) =>
        navigate(item.status === 'DRAFT' ? `/client/new?draft=${item.id}` : `/client/applications/${item.id}`);

    const active = applications.data?.filter((a) => a.needs_action) ?? [];

    return (
        <main className='page'>
            <div className='page-head'>
                <div className='stack'>
                    <div className='stack-8'>
                        <Typography.Text view='primary-medium' color='secondary'>
                            {user?.position} · {user?.company?.name}
                        </Typography.Text>
                        <Typography.TitleResponsive tag='h1' view='xlarge' font='system' weight='bold'>
                            Добрый день, {greeting(user?.full_name)}
                        </Typography.TitleResponsive>
                        <Typography.Text view='primary-large' color='secondary' tag='p'>
                            Деньги на развитие бизнеса: подберём кредит, овердрафт или кредитную линию и сразу покажем
                            платёж
                        </Typography.Text>
                    </div>
                    <div>
                        <Button view='primary' size={56} onClick={() => navigate('/client/new')}>
                            Подобрать кредит
                        </Button>
                    </div>
                </div>
            </div>

            <div className='grid-2'>
                <div className='stack'>
                    {user?.company && <ProactiveOffersCard companyId={user.company.id} />}
                    {user?.company && <StatementCheckCard />}
                    {active.length > 0 && (
                        <section className='card card--tight stack-16'>
                            <SectionTitle>Нужно ваше действие</SectionTitle>
                            {active.map((item) => (
                                <button key={item.id} type='button' className='purpose' onClick={() => open(item)}>
                                    <div style={{ flex: 1 }}>
                                        <Typography.Text view='primary-medium' weight='medium' tag='div'>
                                            {item.status === 'DRAFT' ? 'Черновик заявки' : `Заявка № ${item.number}`} ·{' '}
                                            {item.product_name}
                                        </Typography.Text>
                                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                                            {rub(item.amount)} · {months(item.term_months)}
                                        </Typography.Text>
                                    </div>
                                    <StatusBadge status={item.status} label={item.status_label} />
                                    <ChevronRightMIcon />
                                </button>
                            ))}
                        </section>
                    )}

                    <section className='card card--tight'>
                        <SectionTitle>Мои заявки</SectionTitle>
                        {applications.isLoading && <Loader />}
                        <ErrorPlate error={applications.error} />
                        {applications.data && applications.data.length === 0 && (
                            <Empty
                                title='Заявок пока нет'
                                text='Подберите кредит под задачу бизнеса — это займёт пару минут'
                                action={
                                    <Button view='secondary' size={48} onClick={() => navigate('/client/new')}>
                                        Подобрать кредит
                                    </Button>
                                }
                            />
                        )}
                        {applications.data && applications.data.length > 0 && (
                            <div className='table-wrap'>
                                <table className='simple'>
                                    <thead>
                                        <tr>
                                            <th>Заявка</th>
                                            <th className='col-detail'>Продукт</th>
                                            <th className='num'>Сумма и срок</th>
                                            <th>Статус</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {applications.data.map((item) => (
                                            <tr key={item.id} className='clickable' onClick={() => open(item)}>
                                                <td className='nowrap'>
                                                    <Typography.Text view='primary-small' weight='medium' tag='div'>
                                                        № {item.number}
                                                    </Typography.Text>
                                                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                                                        {date(item.status_changed_at)}
                                                    </Typography.Text>
                                                    <Typography.Text
                                                        view='primary-small'
                                                        color='secondary'
                                                        tag='div'
                                                        className='mobile-only'
                                                    >
                                                        {item.product_name}
                                                    </Typography.Text>
                                                </td>
                                                <td className='col-detail'>{item.product_name}</td>
                                                <td className='num'>
                                                    <Typography.Text view='primary-small' weight='medium' tag='div'>
                                                        {rub(item.amount)}
                                                    </Typography.Text>
                                                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                                                        {months(item.term_months)}
                                                    </Typography.Text>
                                                </td>
                                                <td className='col-status'>
                                                    <div className='stack-8' style={{ alignItems: 'flex-start' }}>
                                                        <StatusBadge status={item.status} label={item.status_label} />
                                                        {item.needs_action && item.status !== 'DRAFT' && (
                                                            <Badge color='orange'>нужно действие</Badge>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                </div>

                <aside className='stack sticky'>
                    {company.data && <CompanyCard company={company.data} refreshable={true} />}
                    <section className='card card--tight stack-16'>
                        <Typography.Text view='primary-large' weight='bold' tag='div'>
                            Как получить кредит
                        </Typography.Text>
                        {HOW_IT_WORKS.map((step, index) => (
                            <div
                                key={step.title}
                                className='row'
                                style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}
                            >
                                <span
                                    className='timeline__dot'
                                    style={{
                                        background: '#fff',
                                        color: '#EF3124',
                                        border: '2px solid #EF3124',
                                        width: 28,
                                        height: 28,
                                    }}
                                >
                                    <Typography.Text view='primary-small' weight='bold'>
                                        {index + 1}
                                    </Typography.Text>
                                </span>
                                <div>
                                    <Typography.Text view='primary-medium' weight='medium' tag='div'>
                                        {step.title}
                                    </Typography.Text>
                                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                                        {step.text}
                                    </Typography.Text>
                                </div>
                            </div>
                        ))}
                    </section>
                </aside>
            </div>
        </main>
    );
}
