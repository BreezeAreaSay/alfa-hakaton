import { Button } from '@alfalab/core-components/button';
import { Plate } from '@alfalab/core-components/plate';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useFaults, usePipelineIssues, useResetDemo, useRetryNow, useSetFault } from '../../api/hooks';
import type { Fault, PipelineIssue } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Empty, ErrorPlate, Loader, PageHead } from '../../components/ui';
import { time } from '../../utils/format';
import { Card, FAULT_MODES, relative, useNow } from './components/common';
import { CompanyBuilderCard } from './components/CompanyBuilderCard';
import './bank.css';

const MODES: Fault['mode'][] = ['ok', 'error', 'timeout', 'slow'];
const CHIP = 'chip bank-chip-sm';
const CHIP_ACTIVE = 'chip bank-chip-sm chip--active';

function FaultsCard({ isAdmin }: { isAdmin: boolean }) {
    const faults = useFaults();
    const setFault = useSetFault();
    const broken = (faults.data ?? []).filter((fault) => fault.mode !== 'ok');

    const restoreAll = async () => {
        try {
            for (const fault of broken) {
                await setFault.mutateAsync({ source: fault.source, mode: 'ok' });
            }
        } catch {
            // ошибку уже показывает ErrorPlate под таблицей
        }
    };

    return (
        <Card
            title='Внешние системы'
            extra={
                isAdmin && broken.length > 0 ? (
                    <Button view='secondary' size={32} loading={setFault.isPending} onClick={() => void restoreAll()}>
                        Включить все
                    </Button>
                ) : undefined
            }
        >
            {faults.isLoading && <Loader />}
            <ErrorPlate error={faults.error} title='Не удалось получить состояние систем' />
            {faults.data && (
                <div className='table-wrap'>
                    <table className='simple bank-faults'>
                        <thead>
                            <tr>
                                <th className='bank-faults__name'>Система</th>
                                <th className='bank-faults__state'>Состояние</th>
                                {isAdmin && <th>Переключить</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {faults.data.map((fault) => {
                                const mode = FAULT_MODES[fault.mode];
                                const switching = setFault.isPending && setFault.variables?.source === fault.source;
                                return (
                                    <tr key={fault.source}>
                                        <td>
                                            <div className='bank-strong'>{fault.title}</div>
                                            <div className='bank-sub'>{fault.source}</div>
                                        </td>
                                        <td className='bank-nowrap'>
                                            <Badge color={mode.color}>
                                                {mode.label}
                                                {fault.mode === 'slow' && fault.latency_ms
                                                    ? ` · ${fault.latency_ms / 1000} с`
                                                    : ''}
                                            </Badge>
                                        </td>
                                        {isAdmin && (
                                            <td>
                                                <div
                                                    className='chips'
                                                    role='group'
                                                    aria-label={`Режим: ${fault.title}`}
                                                >
                                                    {MODES.map((item) => (
                                                        <button
                                                            key={item}
                                                            type='button'
                                                            className={fault.mode === item ? CHIP_ACTIVE : CHIP}
                                                            aria-pressed={fault.mode === item}
                                                            disabled={switching}
                                                            onClick={() =>
                                                                setFault.mutate({ source: fault.source, mode: item })
                                                            }
                                                        >
                                                            {FAULT_MODES[item].label}
                                                        </button>
                                                    ))}
                                                </div>
                                            </td>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            <ErrorPlate error={setFault.error} title='Не удалось переключить режим' />
            {!isAdmin && <div className='bank-sub bank-gap-top'>Переключать может администратор</div>}
        </Card>
    );
}

function HowToCard() {
    return (
        <Card title='Как показать устойчивость к сбоям'>
            <ol className='bank-howto'>
                <li>
                    Включите «Ошибка» для <b>Бюро кредитных историй</b>.
                </li>
                <li>
                    Подайте заявку под учёткой <b>altair</b> — заявка будет ждать ответа бюро, конвейер повторяет запрос
                    с паузами.
                </li>
                <li>Верните «Работает» — обработка продолжится автоматически, без участия сотрудника.</li>
            </ol>
            <div className='bank-sub bank-gap-top'>
                Если источник молчит дольше 15 минут, заявка уходит аналитику с флагом F05 — проверку можно
                перезапустить из досье.
            </div>
        </Card>
    );
}

function DemoCard() {
    const reset = useResetDemo();
    const [confirm, setConfirm] = useState(false);
    return (
        <Card title='Демо-данные'>
            <div className='stack-16'>
                <div className='bank-sub'>
                    Удалит все заявки, журнал и файлы, вернёт внешние системы в рабочий режим и заново создаст стартовые
                    заявки. Учётные записи сохранятся.
                </div>
                {confirm ? (
                    <>
                        <Plate view='attention' rounded={true} limitContentWidth={false} title='Сбросить все заявки?'>
                            Действие нельзя отменить.
                        </Plate>
                        <div className='row'>
                            <Button
                                view='primary'
                                size={40}
                                loading={reset.isPending}
                                onClick={() => reset.mutate(undefined, { onSettled: () => setConfirm(false) })}
                            >
                                Да, сбросить
                            </Button>
                            <Button
                                view='secondary'
                                size={40}
                                disabled={reset.isPending}
                                onClick={() => setConfirm(false)}
                            >
                                Отмена
                            </Button>
                        </div>
                    </>
                ) : (
                    <Button view='secondary' size={40} onClick={() => setConfirm(true)}>
                        Сбросить демо-данные
                    </Button>
                )}
                {reset.data && (
                    <Plate
                        view='positive'
                        rounded={true}
                        limitContentWidth={false}
                        title={`Создано демо-заявок: ${reset.data.preseeded}`}
                    >
                        Заявки уже в конвейере и скоро появятся в очереди.
                    </Plate>
                )}
                <ErrorPlate error={reset.error} title='Сброс не выполнен' />
            </div>
        </Card>
    );
}

const STEP_STATES: Record<string, { label: string; color: 'orange' | 'red' | 'grey' }> = {
    WAITING: { label: 'Ожидание', color: 'orange' },
    FAILED: { label: 'Ошибка', color: 'red' },
};

function IssueRow({ issue, now }: { issue: PipelineIssue; now: number }) {
    const retry = useRetryNow();
    const state = STEP_STATES[issue.step_status] ?? { label: issue.step_status, color: 'grey' as const };
    const canRetry = issue.status === 'IN_PROCESSING' && issue.application_id;
    return (
        <tr>
            <td className='bank-nowrap'>
                {issue.application_id && issue.number ? (
                    <Link className='bank-link' to={`/bank/applications/${issue.application_id}?tab=sources`}>
                        {issue.number}
                    </Link>
                ) : (
                    '—'
                )}
            </td>
            <td>{issue.company_name ?? '—'}</td>
            <td>{issue.step_title}</td>
            <td>
                <Badge color={state.color}>{state.label}</Badge>
            </td>
            <td className='num'>{issue.attempts}</td>
            <td className='bank-error-cell'>{issue.error ?? '—'}</td>
            <td className='bank-nowrap'>
                {issue.waiting_since ? (
                    <>
                        <div>{time(issue.waiting_since)}</div>
                        <div className='bank-sub'>{relative(issue.waiting_since, now)}</div>
                    </>
                ) : (
                    '—'
                )}
            </td>
            <td className='bank-nowrap'>
                {issue.next_retry_at ? (
                    <>
                        <div>{time(issue.next_retry_at)}</div>
                        <div className='bank-sub'>{relative(issue.next_retry_at, now)}</div>
                    </>
                ) : (
                    '—'
                )}
            </td>
            <td>
                {canRetry && (
                    <div className='stack-8'>
                        <Button
                            view='secondary'
                            size={32}
                            loading={retry.isPending}
                            onClick={() => issue.application_id && retry.mutate(issue.application_id)}
                        >
                            Повторить сейчас
                        </Button>
                        {retry.error ? <span className='bank-overdue'>{retry.error.message}</span> : null}
                    </div>
                )}
            </td>
        </tr>
    );
}

function IssuesCard() {
    const issues = usePipelineIssues();
    const now = useNow(1_000);
    return (
        <Card
            title='Заявки, которые ждут источник или упали'
            extra={<span className='bank-sub'>Обновляется автоматически</span>}
        >
            {issues.isLoading && <Loader />}
            <ErrorPlate error={issues.error} title='Не удалось загрузить список' />
            {issues.data && !issues.data.length && (
                <Empty
                    title='Конвейер работает штатно'
                    text='Нет заявок, которые ждут ответа внешних систем или упали с ошибкой'
                />
            )}
            {issues.data && issues.data.length > 0 && (
                <div className='table-wrap'>
                    <table className='simple'>
                        <thead>
                            <tr>
                                <th>Заявка</th>
                                <th>Компания</th>
                                <th>Шаг</th>
                                <th>Состояние</th>
                                <th className='num'>Попытки</th>
                                <th>Ошибка</th>
                                <th>Ожидает с</th>
                                <th>Следующая попытка</th>
                                <th aria-label='Действие' />
                            </tr>
                        </thead>
                        <tbody>
                            {issues.data.map((issue, index) => (
                                <IssueRow
                                    key={`${issue.application_id ?? 'job'}-${issue.step}-${index}`}
                                    issue={issue}
                                    now={now}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Card>
    );
}

export function PipelinePage() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    return (
        <div className='page page--wide bank-page'>
            <PageHead
                title='Конвейер и сбои'
                subtitle='Состояние внешних систем, заявки в ожидании источников и управление демо-стендом'
            />
            <div className='stack'>
                <div className='grid-2 grid-2--bank'>
                    <FaultsCard isAdmin={isAdmin} />
                    <div className='stack'>
                        <HowToCard />
                        {isAdmin && <DemoCard />}
                    </div>
                </div>
                <IssuesCard />
                {isAdmin && <CompanyBuilderCard />}
            </div>
        </div>
    );
}
