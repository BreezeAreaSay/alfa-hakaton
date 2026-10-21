import { Button } from '@alfalab/core-components/button';
import { Typography } from '@alfalab/core-components/typography';
import { ChevronRightMIcon } from '@alfalab/icons-glyph/ChevronRightMIcon';
import { useNavigate } from 'react-router-dom';

import { useApplications, useCompany } from '../../api/hooks';
import type { ApplicationListItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Empty, ErrorPlate, Loader, SectionTitle, StatusBadge } from '../../components/ui';
import { date, months, rub } from '../../utils/format';
import { CompanyCard } from './components/CompanyCard';

const HOW_IT_WORKS = [
    { title: 'Подберите кредит', text: 'Расскажите, на что нужны деньги, — покажем подходящие продукты и платёж' },
    { title: 'Отправьте заявку', text: 'Данные компании подтянем из ЕГРЮЛ, проверка — в среднем несколько минут' },
    { title: 'Подпишите договор', text: 'Подписание и выдача — прямо в кабинете, без визитов и звонков' },
];

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
                <div className='stack-8'>
                    <Typography.TitleResponsive tag='h1' view='large' font='system' weight='bold'>
                        Добрый день, {greeting(user?.full_name)}
                    </Typography.TitleResponsive>
                    <Typography.Text view='primary-medium' color='secondary'>
                        {user?.position} · {user?.company?.name}
                    </Typography.Text>
                </div>
            </div>

            <div className='grid-2'>
                <div className='stack'>
                    <section
                        className='card'
                        style={{ background: '#121212', color: '#fff', display: 'flex', flexDirection: 'column', gap: 16 }}
                    >
                        <Typography.Title tag='h2' view='medium' font='system' weight='bold' color='primary-inverted'>
                            Деньги на развитие бизнеса
                        </Typography.Title>
                        <Typography.Text view='primary-large' color='secondary-inverted' tag='p'>
                            Расскажите о задаче — подберём кредит, овердрафт или кредитную линию и сразу покажем платёж.
                        </Typography.Text>
                        <div>
                            <Button view='primary' size={56} onClick={() => navigate('/client/new')}>
                                Подобрать кредит
                            </Button>
                        </div>
                    </section>

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
                                            <th>Продукт</th>
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
                                                </td>
                                                <td>{item.product_name}</td>
                                                <td className='num'>
                                                    <Typography.Text view='primary-small' weight='medium' tag='div'>
                                                        {rub(item.amount)}
                                                    </Typography.Text>
                                                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                                                        {months(item.term_months)}
                                                    </Typography.Text>
                                                </td>
                                                <td>
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
                            <div key={step.title} className='row' style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                                <span
                                    className='timeline__dot'
                                    style={{ background: '#fff', color: '#EF3124', border: '2px solid #EF3124', width: 28, height: 28 }}
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
