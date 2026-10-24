import { Button } from '@alfalab/core-components/button';
import { Plate } from '@alfalab/core-components/plate';
import { Spinner } from '@alfalab/core-components/spinner';
import { Typography } from '@alfalab/core-components/typography';
import { ArrowLeftMIcon } from '@alfalab/icons-glyph/ArrowLeftMIcon';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useApplication, useCancel, useMeta } from '../../api/hooks';
import type { Application, Meta } from '../../api/types';
import { ErrorPlate, KeyValue, Loader, StatusBadge, StepList } from '../../components/ui';
import { dateTime, months, num, percent, rub } from '../../utils/format';
import { ChatCard } from './components/ChatCard';
import { DocumentList } from './components/DocumentList';
import { InfoRequestSection } from './components/InfoRequestSection';
import { LoanSection } from './components/LoanSection';
import { OfferSection } from './components/OfferSection';
import { SigningSection } from './components/SigningSection';

export function ApplicationPage() {
    const { id } = useParams();
    const { data: application, isLoading, error } = useApplication(id);

    if (isLoading) return <Loader />;
    if (!application) {
        return (
            <main className='page'>
                <ErrorPlate error={error ?? 'Заявка не найдена'} />
            </main>
        );
    }

    return (
        <main className='page'>
            <div className='page-head'>
                <div className='stack-8'>
                    <Link to='/client' className='row back-link'>
                        <ArrowLeftMIcon aria-hidden={true} />
                        <Typography.Text view='primary-medium' color='secondary'>
                            Все заявки
                        </Typography.Text>
                    </Link>
                    <div className='row'>
                        <Typography.TitleResponsive tag='h1' view='large' font='system' weight='bold'>
                            Заявка <span className='nowrap'>№ {application.number}</span>
                        </Typography.TitleResponsive>
                        <StatusBadge status={application.status} label={application.status_label} size={32} />
                    </div>
                    <Typography.Text view='primary-medium' color='secondary'>
                        {application.product.name} · {rub(application.amount)} · {months(application.term_months)}
                    </Typography.Text>
                </div>
            </div>

            <div className='grid-2'>
                <div className='stack'>
                    <CurrentStage application={application} />
                    {application.status !== 'DRAFT' && <ChatCard applicationId={application.id} viewerRole='CLIENT' />}
                    <HistoryCard application={application} />
                </div>
                <aside className='stack sticky'>
                    <ParametersCard application={application} />
                    {!FINAL_STATUSES.has(application.status) && <TimelineCard application={application} />}
                    {application.documents.length > 0 && (
                        <section className='card card--tight stack-16'>
                            <Typography.Text view='primary-large' weight='bold' tag='div'>
                                Документы
                            </Typography.Text>
                            <DocumentList documents={application.documents} />
                        </section>
                    )}
                </aside>
            </div>
        </main>
    );
}

/** Стоп-факторы S01–S04 не зависят от продукта: другой продукт банк тоже не выдаст, пока причина не устранена. */
const PRODUCT_INDEPENDENT_STOP_FACTORS = ['S01', 'S02', 'S03', 'S04'];

function blockedForAnyProduct(application: Application, meta: Meta | undefined): boolean {
    if (!meta) return true;
    const texts = new Set(PRODUCT_INDEPENDENT_STOP_FACTORS.map((code) => meta.stop_factors[code]));
    return application.explanation.rejection.some((text) => texts.has(text));
}

function CurrentStage({ application }: { application: Application }) {
    const navigate = useNavigate();
    const { data: meta } = useMeta();
    const openRequest = application.info_requests.find((r) => r.status === 'OPEN');

    switch (application.status) {
        case 'DRAFT':
            return (
                <section className='card stack-16'>
                    <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                        Черновик заявки
                    </Typography.Title>
                    <Typography.Text view='primary-medium' color='secondary' tag='p'>
                        Заявка ещё не отправлена в банк.
                    </Typography.Text>
                    <div>
                        <Button
                            view='primary'
                            size={56}
                            onClick={() => navigate(`/client/new?draft=${application.id}`)}
                        >
                            Продолжить заполнение
                        </Button>
                    </div>
                </section>
            );
        case 'SUBMITTED':
        case 'IN_PROCESSING': {
            const waiting = application.steps.find((s) => s.status === 'WAITING');
            return (
                <section className='card stack-16'>
                    <div className='row' style={{ flexWrap: 'nowrap' }}>
                        <Spinner visible={true} size={24} lineWidth={3} />
                        <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                            Проверяем заявку
                        </Typography.Title>
                    </div>
                    <Typography.Text view='primary-medium' color='secondary' tag='p'>
                        Сверяем данные с ЕГРЮЛ, ФНС и бюро кредитных историй и оцениваем риск. Обычно это занимает пару
                        минут — страницу можно закрыть, результат придёт в уведомления кабинета.
                    </Typography.Text>
                    {waiting && (
                        <Plate
                            view='attention'
                            rounded={true}
                            limitContentWidth={false}
                            title={waiting.waiting_text ?? 'Ждём ответ'}
                        >
                            Внешний сервис отвечает с задержкой. Заявка не потеряется — мы повторяем запрос
                            автоматически.
                        </Plate>
                    )}
                    <StepList steps={application.steps} />
                </section>
            );
        }
        case 'NEED_INFO':
            return openRequest ? <InfoRequestSection application={application} request={openRequest} /> : null;
        case 'MANUAL_REVIEW':
            return (
                <section className='card stack-16'>
                    <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                        Заявку рассматривает специалист
                    </Typography.Title>
                    <Typography.Text view='primary-medium' color='secondary' tag='p'>
                        Автоматическая проверка пройдена, по вашей заявке нужно решение специалиста —{' '}
                        {application.sla_due_at
                            ? `ответим до ${dateTime(application.sla_due_at)}`
                            : 'ответим в течение рабочего дня'}
                        . Если понадобятся документы, запрос появится здесь. Вопрос можно задать в чате ниже.
                    </Typography.Text>
                    <StepList steps={application.steps} />
                </section>
            );
        case 'OFFER':
            return <OfferSection application={application} />;
        case 'ACCEPTED':
        case 'SIGNED':
            return (
                <section className='card stack-16'>
                    <div className='row' style={{ flexWrap: 'nowrap' }}>
                        <Spinner visible={true} size={24} lineWidth={3} />
                        <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                            {application.status === 'ACCEPTED' ? 'Готовим документы' : 'Перечисляем деньги'}
                        </Typography.Title>
                    </div>
                    <Typography.Text view='primary-medium' color='secondary' tag='p'>
                        {application.status === 'ACCEPTED'
                            ? 'Договор и график платежей появятся здесь через несколько секунд.'
                            : 'Договор подписан. Открываем ссудный счёт и перечисляем деньги.'}
                    </Typography.Text>
                </section>
            );
        case 'SIGNING':
            return <SigningSection application={application} />;
        case 'ISSUED':
            return application.loan ? <LoanSection loan={application.loan} /> : null;
        case 'REJECTED':
            return (
                <section className='card stack-16'>
                    <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                        Банк не может выдать кредит
                    </Typography.Title>
                    {application.explanation.rejection.map((text) => (
                        <Plate key={text} view='negative' rounded={true} limitContentWidth={false} title={text} />
                    ))}
                    {application.explanation.advice.length > 0 && (
                        <div className='tile stack-8'>
                            <Typography.Text view='primary-medium' weight='bold' tag='div'>
                                Что повлияло на решение
                            </Typography.Text>
                            {application.explanation.advice.map((text) => (
                                <Typography.Text key={text} view='primary-small' tag='div'>
                                    · {text}
                                </Typography.Text>
                            ))}
                        </div>
                    )}
                    {application.explanation.next_steps.length > 0 && (
                        <div className='tile stack-8'>
                            <Typography.Text view='primary-medium' weight='bold' tag='div'>
                                Что поможет
                            </Typography.Text>
                            {application.explanation.next_steps.map((text) => (
                                <Typography.Text key={text} view='primary-small' tag='div'>
                                    · {text}
                                </Typography.Text>
                            ))}
                        </div>
                    )}
                    {application.explanation.alternatives.length > 0 && (
                        <div className='stack-8'>
                            <Typography.Text view='primary-medium' weight='bold' tag='div'>
                                Вам может подойти
                            </Typography.Text>
                            <div className='proactive__grid'>
                                {application.explanation.alternatives.map((item) => (
                                    <div key={item.product_code} className='tile stack-8'>
                                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                                            {item.product_name}
                                        </Typography.Text>
                                        <Typography.Text view='primary-large' weight='bold' tag='div'>
                                            до {rub(item.max_amount)}
                                        </Typography.Text>
                                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                                            {months(item.term_months)} · от {percent(item.rate)} годовых
                                        </Typography.Text>
                                        <div>
                                            <Button
                                                view='secondary'
                                                size={40}
                                                onClick={() =>
                                                    navigate(
                                                        `/client/new?purpose=${application.purpose}&amount=${num(item.max_amount)}&term=${item.term_months}&product=${item.product_code}`,
                                                    )
                                                }
                                            >
                                                Оформить
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {!blockedForAnyProduct(application, meta) && (
                        <div>
                            <Button view='secondary' size={48} onClick={() => navigate('/client/new')}>
                                Подобрать другой продукт
                            </Button>
                        </div>
                    )}
                </section>
            );
        default:
            return (
                <section className='card stack-16'>
                    <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                        {application.status_label}
                    </Typography.Title>
                    <Typography.Text view='primary-medium' color='secondary' tag='p'>
                        {application.next_step}.
                    </Typography.Text>
                    <div>
                        <Button view='primary' size={48} onClick={() => navigate('/client/new')}>
                            Новая заявка
                        </Button>
                    </div>
                </section>
            );
    }
}

const FINAL_STATUSES = new Set(['DRAFT', 'ISSUED', 'REJECTED', 'DECLINED', 'CANCELLED', 'EXPIRED']);

/** Сколько ждать до денег: ожидаемое время этапов и живые сроки из таймеров процесса. */
function TimelineCard({ application }: { application: Application }) {
    const status = application.status;
    const openRequest = application.info_requests.find((r) => r.status === 'OPEN');
    const activeOffer = application.offers.find((o) => o.status === 'ACTIVE');
    const items: [string, string][] = [
        [
            'Автоматическая проверка',
            status === 'SUBMITTED' || status === 'IN_PROCESSING'
                ? 'идёт сейчас, обычно несколько минут'
                : 'несколько минут',
        ],
        [
            'Решение специалиста',
            status === 'MANUAL_REVIEW' && application.sla_due_at
                ? `до ${dateTime(application.sla_due_at)}`
                : 'если понадобится — до одного рабочего дня',
        ],
        ['Ответ на запрос банка', openRequest ? `до ${dateTime(openRequest.due_at)}` : 'если понадобится — 3 дня'],
        ['Предложение действует', activeOffer ? `до ${dateTime(activeOffer.valid_until)}` : '7 дней'],
        ['Деньги на счёте', 'в день подписания договора'],
    ];
    return (
        <section className='card card--tight stack-16'>
            <Typography.Text view='primary-large' weight='bold' tag='div'>
                Сколько это занимает
            </Typography.Text>
            <KeyValue items={items} />
        </section>
    );
}

function ParametersCard({ application }: { application: Application }) {
    const cancel = useCancel();
    const [confirm, setConfirm] = useState(false);
    return (
        <section className='card card--tight stack-16'>
            <Typography.Text view='primary-large' weight='bold' tag='div'>
                Параметры заявки
            </Typography.Text>
            <KeyValue
                items={[
                    ['Компания', application.company.name],
                    ['Продукт', application.product.name],
                    ['Сумма', rub(application.amount)],
                    ['Срок', months(application.term_months)],
                    ['Цель', application.purpose_label],
                    ['Создана', dateTime(application.created_at)],
                    ['Отправлена', dateTime(application.submitted_at)],
                ]}
            />
            {application.purpose_text && (
                <Typography.Text view='primary-small' color='secondary' tag='p'>
                    {application.purpose_text}
                </Typography.Text>
            )}
            <ErrorPlate error={cancel.error} />
            {application.can_cancel &&
                (confirm ? (
                    <div className='row'>
                        <Button
                            view='secondary'
                            size={40}
                            loading={cancel.isPending}
                            onClick={() => cancel.mutate(application.id)}
                        >
                            Да, отозвать
                        </Button>
                        <Button view='transparent' size={40} onClick={() => setConfirm(false)}>
                            Нет
                        </Button>
                    </div>
                ) : (
                    <Button view='transparent' size={40} onClick={() => setConfirm(true)}>
                        Отозвать заявку
                    </Button>
                ))}
        </section>
    );
}

function HistoryCard({ application }: { application: Application }) {
    if (!application.history.length) return null;
    return (
        <section className='card card--tight stack-16'>
            <Typography.Text view='primary-large' weight='bold' tag='div'>
                История заявки
            </Typography.Text>
            <ol className='timeline'>
                {[...application.history].reverse().map((item, index) => (
                    <li key={`${item.created_at}-${index}`} className='timeline__item'>
                        <span
                            className={`timeline__dot ${index === 0 ? 'timeline__dot--active' : 'timeline__dot--done'}`}
                        />
                        <div>
                            <Typography.Text view='primary-medium' weight='medium' tag='div'>
                                {item.to_label}
                            </Typography.Text>
                            <Typography.Text view='primary-small' color='secondary' tag='div'>
                                {dateTime(item.created_at)}
                                {item.actor === 'UNDERWRITER' ? ' · специалист банка' : ''}
                            </Typography.Text>
                        </div>
                    </li>
                ))}
            </ol>
        </section>
    );
}
