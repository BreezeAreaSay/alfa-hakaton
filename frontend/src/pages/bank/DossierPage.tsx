import { Button } from '@alfalab/core-components/button';
import { PrimaryTabListResponsive } from '@alfalab/core-components/tabs';
import { Typography } from '@alfalab/core-components/typography';
import { ArrowLeftMIcon } from '@alfalab/icons-glyph/ArrowLeftMIcon';
import { DocumentLinesMIcon } from '@alfalab/icons-glyph/DocumentLinesMIcon';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { openInNewTab } from '../../api/client';
import { keys, useAssign, useDossier, useMessages, useMeta, useProducts } from '../../api/hooks';
import type { Dossier } from '../../api/types';
import { ErrorPlate, Loader, StatusBadge } from '../../components/ui';
import { dateTime, legalFormLabel, months, rub, timeLeft } from '../../utils/format';
import { ChatTab } from './components/ChatTab';
import { PriorityBadge, RiskBadge, useNow, useStickyTop } from './components/common';
import { DecisionPanel } from './components/DecisionPanel';
import { DocumentsTab } from './components/DocumentsTab';
import { HistoryTab } from './components/HistoryTab';
import { ScoringTab } from './components/ScoringTab';
import { SourcesTab } from './components/SourcesTab';
import { SummaryTab } from './components/SummaryTab';
import './bank.css';

type TabId = 'summary' | 'sources' | 'scoring' | 'documents' | 'chat' | 'history';

const TABS: { id: TabId; title: string }[] = [
    { id: 'summary', title: 'Сводка' },
    { id: 'sources', title: 'Источники' },
    { id: 'scoring', title: 'Скоринг' },
    { id: 'documents', title: 'Документы' },
    { id: 'chat', title: 'Чат' },
    { id: 'history', title: 'История' },
];

const isTab = (value: string | null): value is TabId => TABS.some((tab) => tab.id === value);

function BackLink() {
    return (
        <Link to='/bank' className='bank-back'>
            <ArrowLeftMIcon width={20} height={20} aria-hidden={true} />
            Очередь заявок
        </Link>
    );
}

/** PDF для аудита: входные данные, скоринг, правила политики и решения людей. Есть, когда есть что обосновывать. */
function JustificationButton({ data }: { data: Dossier }) {
    const app = data.application;
    const client = useQueryClient();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<unknown>(null);
    if (!data.scoring && !data.last_decision) return null;

    const open = async () => {
        setError(null);
        setLoading(true);
        try {
            await openInNewTab(`/api/bank/applications/${app.id}/justification.pdf`);
            // формирование попадает в журнал действий — обновляем досье, чтобы запись появилась в «Истории»
            void client.invalidateQueries({ queryKey: keys.dossier(app.id) });
        } catch (e) {
            setError(e);
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <Button
                view='secondary'
                size={40}
                block={true}
                leftAddons={<DocumentLinesMIcon width={20} height={20} aria-hidden={true} />}
                loading={loading}
                onClick={() => void open()}
            >
                Скачать обоснование
            </Button>
            <ErrorPlate error={error} title='Не удалось сформировать обоснование' />
        </>
    );
}

function Header({ data }: { data: Dossier }) {
    const app = data.application;
    const assign = useAssign();
    useNow(30_000);
    // Ничью заявку берут в работу, заявку коллеги — забирают себе; своя кнопки не требует
    const canAssign = (app.status === 'MANUAL_REVIEW' || app.status === 'NEED_INFO') && !data.assignee_is_me;
    const overdue = Boolean(
        data.sla_due_at && app.status === 'MANUAL_REVIEW' && new Date(data.sla_due_at).getTime() < Date.now(),
    );
    const facts: [string, string][] = [
        ['Продукт', app.product.name],
        ['Сумма', rub(app.amount)],
        ['Срок', months(app.term_months)],
        ['Цель', app.purpose_label],
    ];
    return (
        <section className='card card--tight bank-head'>
            <div className='bank-head__main'>
                <div className='row bank-row-tight'>
                    <Typography.Text view='primary-small' color='secondary'>
                        Заявка № {app.number} · подана {dateTime(app.submitted_at)}
                    </Typography.Text>
                    <StatusBadge status={app.status} label={app.status_label} />
                    {data.scoring && <RiskBadge riskClass={data.scoring.risk_class} score={data.scoring.score} />}
                </div>
                <Typography.TitleResponsive tag='h1' view='medium' font='system' weight='bold'>
                    {app.company.name}
                </Typography.TitleResponsive>
                <Typography.Text view='primary-small' color='secondary' tag='div'>
                    ИНН {app.company.inn} · {legalFormLabel(app.company.legal_form)}
                    {app.company.okved_name ? ` · ${app.company.okved_name}` : ''}
                </Typography.Text>
                <dl className='bank-facts'>
                    {facts.map(([label, value]) => (
                        <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                        </div>
                    ))}
                </dl>
            </div>
            <div className='bank-head__side'>
                {app.status === 'MANUAL_REVIEW' && data.sla_due_at && (
                    <div>
                        <div className='bank-caption'>Срок рассмотрения</div>
                        <div className={`bank-head__sla${overdue ? ' bank-overdue' : ''}`}>
                            {timeLeft(data.sla_due_at)}
                        </div>
                        <div className='bank-sub'>до {dateTime(data.sla_due_at)}</div>
                    </div>
                )}
                {data.priority && (
                    <div>
                        <div className='bank-caption'>Приоритет</div>
                        <PriorityBadge priority={data.priority} />
                        {data.priority_reasons.length > 0 && (
                            <ul className='bank-reasons'>
                                {data.priority_reasons.map((reason) => (
                                    <li key={reason}>{reason}</li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
                <div>
                    <div className='bank-caption'>Исполнитель</div>
                    <div className='bank-strong'>
                        {data.assignee ? `${data.assignee}${data.assignee_is_me ? ' (вы)' : ''}` : 'не назначен'}
                    </div>
                </div>
                {canAssign && (
                    <Button
                        view='secondary'
                        size={40}
                        block={true}
                        loading={assign.isPending}
                        onClick={() => assign.mutate(app.id)}
                    >
                        {data.assignee ? 'Взять себе' : 'Взять в работу'}
                    </Button>
                )}
                <ErrorPlate error={assign.error} title='Не удалось взять в работу' />
                <JustificationButton data={data} />
            </div>
        </section>
    );
}

export function DossierPage() {
    const { id } = useParams<{ id: string }>();
    const [params, setParams] = useSearchParams();
    const requested = params.get('tab');
    const tab: TabId = isTab(requested) ? requested : 'summary';
    const dossier = useDossier(id);
    const meta = useMeta();
    const products = useProducts();
    const data = dossier.data;
    const chatAvailable = Boolean(data && data.application.status !== 'DRAFT');
    const messages = useMessages(id ?? '', Boolean(id) && chatAvailable);
    const [asideRef, asideTop] = useStickyTop();

    if (dossier.isLoading) {
        return (
            <div className='page page--wide bank-page'>
                <BackLink />
                <Loader text='Загружаем досье…' />
            </div>
        );
    }

    if (!data) {
        return (
            <div className='page page--wide bank-page'>
                <BackLink />
                <ErrorPlate error={dossier.error ?? 'Заявка не найдена'} title='Не удалось открыть досье' />
            </div>
        );
    }

    const app = data.application;
    const counts: Partial<Record<TabId, number>> = {
        documents: app.documents.length,
        chat: messages.data?.length ?? 0,
    };

    return (
        <div className='page page--wide bank-page'>
            <BackLink />
            <Header data={data} />
            <div className='grid-2 grid-2--bank'>
                <div className='stack bank-main'>
                    <div className='bank-tabs'>
                        <PrimaryTabListResponsive
                            size='s'
                            selectedId={tab}
                            titles={TABS.map((item) => ({
                                id: item.id,
                                title: item.title,
                                rightAddons: counts[item.id] ? (
                                    <span className='bank-tab-count'>{counts[item.id]}</span>
                                ) : undefined,
                            }))}
                            onChange={(_, { selectedId }) => setParams({ tab: String(selectedId) }, { replace: true })}
                        />
                    </div>
                    {tab === 'summary' && <SummaryTab data={data} meta={meta.data} />}
                    {tab === 'sources' && <SourcesTab data={data} meta={meta.data} />}
                    {tab === 'scoring' && <ScoringTab data={data} />}
                    {tab === 'documents' && <DocumentsTab app={app} />}
                    {tab === 'chat' && <ChatTab app={app} />}
                    {tab === 'history' && <HistoryTab data={data} meta={meta.data} products={products.data} />}
                </div>
                <aside className='sticky' ref={asideRef} style={asideTop === undefined ? undefined : { top: asideTop }}>
                    <DecisionPanel data={data} meta={meta.data} />
                </aside>
            </div>
        </div>
    );
}
