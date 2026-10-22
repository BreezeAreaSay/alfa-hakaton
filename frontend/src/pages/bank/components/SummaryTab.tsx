import { Plate } from '@alfalab/core-components/plate';
import type { ReactNode } from 'react';

import { useAiStatus, useAiSummary } from '../../../api/hooks';
import type { DecisionView, Dossier, DocumentItem, InfoRequest, Meta, Offer } from '../../../api/types';
import { Badge, KeyValue, Metric } from '../../../components/ui';
import type { StatusColor } from '../../../utils/format';
import { date, dateTime, months, num, percent, rub } from '../../../utils/format';
import { CONSTRAINT_LABELS, Card, Check, FLAG_HINTS, OUTCOME_COLORS, OUTCOME_LABELS, Sub } from './common';
import { type EgrulResult, sourceResult } from './SourcesTab';

const OFFER_STATUS: Record<Offer['status'], { label: string; color: StatusColor }> = {
    ACTIVE: { label: 'Действует', color: 'green' },
    ACCEPTED: { label: 'Принято клиентом', color: 'teal' },
    DECLINED: { label: 'Клиент отказался', color: 'grey' },
    EXPIRED: { label: 'Истёк срок', color: 'grey' },
    VOID: { label: 'Аннулировано', color: 'grey' },
};

const INFO_STATUS: Record<InfoRequest['status'], { label: string; color: StatusColor }> = {
    OPEN: { label: 'Ждём ответ', color: 'orange' },
    ANSWERED: { label: 'Ответ получен', color: 'green' },
    EXPIRED: { label: 'Срок истёк', color: 'grey' },
    CANCELLED: { label: 'Отменён', color: 'grey' },
};

function ApplicationFacts({ data, meta }: { data: Dossier; meta: Meta | undefined }) {
    const app = data.application;
    const company = app.company;
    const egrul = sourceResult<EgrulResult>(data.sources.EGRUL);
    const registry = egrul && egrul.found !== false ? egrul : null;
    const companyStatus = registry?.status ?? company.status;
    const okved = registry?.okved ?? company.okved;
    const director = registry?.director?.name ?? company.director_name;
    const directorSince = registry?.director?.since;

    const request: [ReactNode, ReactNode][] = [
        ['Продукт', app.product.name],
        ['Сумма', rub(app.amount)],
        ['Срок', months(app.term_months)],
        ['Цель', app.purpose_label],
    ];
    if (app.purpose_text) request.push(['Описание цели', app.purpose_text]);
    request.push(['Заявленная выручка', app.declared_revenue ? `${rub(app.declared_revenue)} в год` : 'не указана']);
    if (app.collateral_value)
        request.push(['Залог', `${app.collateral_type ?? 'Имущество'}, ${rub(app.collateral_value)}`]);
    request.push(['Подана', dateTime(app.submitted_at)]);

    const age = company.business_months !== null ? ` · ${months(company.business_months)}` : '';
    const registered = company.registration_date ? `${date(company.registration_date)}${age}` : '—';
    const facts: [ReactNode, ReactNode][] = [
        ['Наименование', registry?.name ?? company.name],
        ['ИНН / ОГРН', `${company.inn} / ${registry?.ogrn ?? company.ogrn ?? '—'}`],
        ['Регистрация', registered],
        [
            'Статус',
            companyStatus ? (
                <Badge color={companyStatus === 'ACTIVE' ? 'green' : 'red'}>
                    {meta?.company_statuses[companyStatus] ?? companyStatus}
                </Badge>
            ) : (
                '—'
            ),
        ],
        ['ОКВЭД', okved ? `${okved} · ${registry?.okved_name ?? company.okved_name ?? ''}` : '—'],
        ['Адрес', registry?.address ?? company.address ?? '—'],
        ['Руководитель', director ? `${director}${directorSince ? `, с ${date(directorSince)}` : ''}` : '—'],
        ['Клиент банка', company.is_bank_client ? `да, счёт с ${date(company.bank_account_opened_at)}` : 'нет'],
    ];

    return (
        <Card title='Заявка и компания'>
            <div className='bank-cols'>
                <div>
                    <div className='bank-caption'>Заявка</div>
                    <KeyValue items={request} />
                </div>
                <div>
                    <div className='bank-caption'>Компания{registry ? ' · по данным ЕГРЮЛ' : ''}</div>
                    <KeyValue items={facts} />
                </div>
            </div>
        </Card>
    );
}

function reviewReason(data: Dossier): string | null {
    const history = data.application.history;
    for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i].to_status === 'MANUAL_REVIEW') return history[i].reason;
    }
    return null;
}

function FlagsCard({ data }: { data: Dossier }) {
    const auto = data.auto_decision;
    const flags = auto?.flags ?? [];
    const stops = auto?.stop_factors ?? [];
    const reason = data.application.status === 'MANUAL_REVIEW' ? reviewReason(data) : null;
    return (
        <Card
            title='Флаги и стоп-факторы'
            extra={auto ? <span className='bank-sub'>по итогам автоматической проверки</span> : undefined}
        >
            <div className='stack-8'>
                {!auto && <Sub>Автоматическая проверка ещё не завершена</Sub>}
                {stops.map((item) => (
                    <Plate
                        key={item.code}
                        view='negative'
                        rounded={true}
                        limitContentWidth={false}
                        title={`${item.code} · ${item.title}`}
                    />
                ))}
                {flags.map((item) => (
                    <Plate
                        key={item.code}
                        view='attention'
                        rounded={true}
                        limitContentWidth={false}
                        title={`${item.code} · ${item.title}`}
                    >
                        {FLAG_HINTS[item.code]}
                    </Plate>
                ))}
                {auto && !flags.length && !stops.length && (
                    <Plate view='positive' rounded={true} limitContentWidth={false} title='Флагов и стоп-факторов нет'>
                        {reason
                            ? `Причина ручного рассмотрения: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
                            : null}
                    </Plate>
                )}
            </div>
        </Card>
    );
}

/**
 * Подсказка модели: сильные стороны и риски по данным досье. Решения она не принимает — блок помечен и скрыт,
 * если ИИ выключен или модель не ответила. Запрашивается, когда скоринг уже посчитан.
 */
function AiSummaryCard({ data }: { data: Dossier }) {
    const app = data.application;
    const status = useAiStatus();
    const enabled = Boolean(status.data?.enabled && data.scoring);
    const summary = useAiSummary(app.id, `${app.run_no}:${data.last_decision?.id ?? '-'}`, enabled);
    if (!enabled || summary.isError) return null;
    const model = summary.data?.model ?? status.data?.model;
    return (
        <Card title='Подсказка ИИ' extra={<Badge color='grey'>не решение</Badge>}>
            {summary.data ? (
                <ul className='bank-checks'>
                    {summary.data.points.map((point, index) => {
                        const ok = point.startsWith('+ ') ? true : point.startsWith('− ') ? false : null;
                        return <Check key={index} ok={ok} label={ok === null ? point : point.slice(2)} />;
                    })}
                </ul>
            ) : (
                <Sub>Модель готовит сводку по данным досье…</Sub>
            )}
            <div className='bank-sub bank-ai-note'>
                Текст сгенерирован моделью{model ? ` ${model}` : ''} по данным досье. Решение принимают скоринговая
                карта, кредитная политика и аналитик — сверяйте пункты с вкладками досье.
            </div>
        </Card>
    );
}

function LimitCard({ data }: { data: Dossier }) {
    const limit = data.limit;
    const requested = num(data.application.amount);
    if (!limit || limit.limit === null) {
        const why = !data.scoring
            ? 'скоринг ещё не выполнен'
            : data.scoring.risk_class === 'E'
              ? 'для класса риска E кредит не предлагается'
              : 'нет данных о выручке — нужна отчётность или выписка по счёту';
        return (
            <Card title='Расчётный лимит'>
                <Sub>Лимит не рассчитан: {why}.</Sub>
            </Card>
        );
    }
    const above = requested > limit.limit;
    return (
        <Card title='Расчётный лимит'>
            <div className='stack-16'>
                <div className='metrics'>
                    <Metric label='Лимит' value={rub(limit.limit)} hint={limit.phrase ?? undefined} />
                    <Metric label='Расчётная ставка' value={percent(limit.rate)} hint='годовых, не ниже' />
                    <Metric
                        label='Запрошено'
                        value={<span className={above ? 'bank-attention' : undefined}>{rub(requested)}</span>}
                        hint={above ? `выше лимита на ${rub(requested - limit.limit)}` : 'в пределах лимита'}
                    />
                </div>
                <div className='table-wrap'>
                    <table className='simple'>
                        <thead>
                            <tr>
                                <th>Ограничение</th>
                                <th className='num'>Сумма</th>
                                <th>Пояснение</th>
                            </tr>
                        </thead>
                        <tbody>
                            {limit.constraints.map((item) => {
                                const binding = item.code === limit.binding;
                                return (
                                    <tr key={item.code} className={binding ? 'bank-row-binding' : undefined}>
                                        <td>
                                            <span className='row bank-row-tight'>
                                                <span className={binding ? 'bank-strong' : undefined}>
                                                    {CONSTRAINT_LABELS[item.code] ?? item.code}
                                                </span>
                                                {binding && <Badge color='blue'>определяет лимит</Badge>}
                                            </span>
                                        </td>
                                        <td className={`num${binding ? ' bank-strong' : ''}`}>{rub(item.amount)}</td>
                                        <td className='bank-sub'>
                                            {item.max_payment !== undefined
                                                ? `Платёж не больше ${rub(item.max_payment)} в месяц`
                                                : ''}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </Card>
    );
}

function DecisionLine({ decision, meta }: { decision: DecisionView; meta: Meta | undefined }) {
    const who = decision.kind === 'AUTO' ? 'автоматически' : (decision.decided_by ?? 'аналитик');
    return (
        <div className='stack-8'>
            <div className='row bank-row-tight'>
                <Badge color={OUTCOME_COLORS[decision.outcome] ?? 'grey'}>
                    {OUTCOME_LABELS[decision.outcome] ?? decision.outcome}
                </Badge>
                <span className='bank-sub'>
                    {who} · {dateTime(decision.created_at)} · политика {decision.policy_version}
                </span>
            </div>
            {decision.reason_codes.length > 0 && (
                <div className='bank-sub'>
                    Причина:{' '}
                    {decision.reason_codes
                        .map((code) => `${code} ${meta?.reasons[code]?.bank ?? ''}`.trim())
                        .join(', ')}
                </div>
            )}
            {decision.comment && <div className='bank-quote'>{decision.comment}</div>}
        </div>
    );
}

function TraceCard({ data, meta }: { data: Dossier; meta: Meta | undefined }) {
    const auto = data.auto_decision;
    const manual = data.last_decision && data.last_decision.kind === 'MANUAL' ? data.last_decision : null;
    if (!auto) return null;
    return (
        <Card
            title='Как принималось решение'
            extra={<span className='bank-sub'>Кредитная политика {auto.policy_version}</span>}
        >
            <div className='stack-16'>
                <div className='table-wrap'>
                    <table className='simple'>
                        <thead>
                            <tr>
                                <th>Правило</th>
                                <th>Результат</th>
                                <th>Подробности</th>
                            </tr>
                        </thead>
                        <tbody>
                            {auto.trace.map((row, index) => (
                                <tr key={index}>
                                    <td>{row.rule}</td>
                                    <td className='bank-strong'>{row.result}</td>
                                    <td className='bank-sub'>{row.detail || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <DecisionLine decision={auto} meta={meta} />
                {manual && (
                    <div className='tile stack-8'>
                        <div className='bank-caption'>Решение аналитика</div>
                        <DecisionLine decision={manual} meta={meta} />
                    </div>
                )}
            </div>
        </Card>
    );
}

function OffersCard({ offers }: { offers: Offer[] }) {
    return (
        <Card title='Предложения клиенту'>
            <div className='table-wrap'>
                <table className='simple'>
                    <thead>
                        <tr>
                            <th>Вариант</th>
                            <th className='num'>Сумма</th>
                            <th>Срок</th>
                            <th className='num'>Ставка</th>
                            <th className='num'>Платёж</th>
                            <th>Действует до</th>
                            <th>Статус</th>
                        </tr>
                    </thead>
                    <tbody>
                        {offers.map((offer) => (
                            <tr key={offer.id}>
                                <td>
                                    <div className='bank-strong'>{offer.product_name}</div>
                                    <div className='bank-sub'>
                                        {offer.note ??
                                            (offer.kind === 'COUNTER' ? 'Контрпредложение' : 'Как запрошено')}
                                    </div>
                                </td>
                                <td className='num'>{rub(offer.amount)}</td>
                                <td className='bank-nowrap'>{months(offer.term_months)}</td>
                                <td className='num'>{percent(offer.rate)}</td>
                                <td className='num' title={offer.payment_label}>
                                    {rub(offer.monthly_payment)}
                                </td>
                                <td className='bank-nowrap'>{dateTime(offer.valid_until)}</td>
                                <td>
                                    <Badge color={OFFER_STATUS[offer.status].color}>
                                        {OFFER_STATUS[offer.status].label}
                                    </Badge>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Card>
    );
}

function InfoRequestsCard({ requests, documents }: { requests: InfoRequest[]; documents: DocumentItem[] }) {
    return (
        <Card title='Запросы информации'>
            <div className='stack-16'>
                {[...requests].reverse().map((request) => {
                    const files = documents.filter((doc) => doc.info_request_id === request.id);
                    const state = INFO_STATUS[request.status];
                    return (
                        <div key={request.id} className='tile stack-8'>
                            <div className='row row--between'>
                                <span className='bank-strong'>
                                    {request.origin === 'SYSTEM' ? 'Автоматический запрос' : 'Запрос аналитика'} ·{' '}
                                    {dateTime(request.created_at)}
                                </span>
                                <Badge color={state.color}>{state.label}</Badge>
                            </div>
                            <ul className='bank-list'>
                                {request.items.map((item) => (
                                    <li key={item.code}>{item.title}</li>
                                ))}
                            </ul>
                            {request.comment && <div className='bank-sub'>Комментарий: {request.comment}</div>}
                            {request.status === 'OPEN' && (
                                <div className='bank-sub'>Ответить до {dateTime(request.due_at)}</div>
                            )}
                            {(request.answer_text || files.length > 0) && (
                                <div className='bank-answer'>
                                    <div className='bank-caption'>
                                        Ответ клиента{request.answered_at ? ` · ${dateTime(request.answered_at)}` : ''}
                                    </div>
                                    {request.answer_text && <div>{request.answer_text}</div>}
                                    {files.length > 0 && (
                                        <div className='bank-sub'>
                                            Файлы: {files.map((doc) => doc.file_name).join(', ')}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}

export function SummaryTab({ data, meta }: { data: Dossier; meta: Meta | undefined }) {
    const app = data.application;
    return (
        <div className='stack'>
            <ApplicationFacts data={data} meta={meta} />
            <FlagsCard data={data} />
            <AiSummaryCard data={data} />
            <LimitCard data={data} />
            <TraceCard data={data} meta={meta} />
            {app.offers.length > 0 && <OffersCard offers={app.offers} />}
            {app.info_requests.length > 0 && (
                <InfoRequestsCard requests={app.info_requests} documents={app.documents} />
            )}
        </div>
    );
}
