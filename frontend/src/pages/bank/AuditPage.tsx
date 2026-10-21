import { Button } from '@alfalab/core-components/button';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAudit, useMeta, useProducts, useQueue } from '../../api/hooks';
import type { AuditRow } from '../../api/types';
import { Badge, Empty, ErrorPlate, Loader, PageHead } from '../../components/ui';
import { dateTime } from '../../utils/format';
import { ACTION_COLORS, ACTION_LABELS, auditDetails, entityTitle } from './components/audit';
import { ACTOR_LABELS, shortId } from './components/common';
import './bank.css';

type Group = 'all' | 'applications' | 'documents' | 'admin' | 'login';

const GROUPS: { key: Group; label: string; test: (row: AuditRow) => boolean }[] = [
    { key: 'all', label: 'Все действия', test: () => true },
    {
        key: 'applications',
        label: 'Заявки',
        test: (row) =>
            ['STATUS_CHANGED', 'DRAFT_CREATED', 'DRAFT_DELETED', 'ASSIGNED', 'PIPELINE_RETRY'].includes(row.action),
    },
    {
        key: 'documents',
        label: 'Документы и подписи',
        test: (row) => ['DOCUMENT_UPLOADED', 'AGREEMENT_SIGNED'].includes(row.action),
    },
    {
        key: 'admin',
        label: 'Сбои и администрирование',
        test: (row) => ['FAULT_SET', 'DEMO_RESET'].includes(row.action),
    },
    { key: 'login', label: 'Входы', test: (row) => row.action === 'LOGIN' },
];

const PAGE_SIZE = 50;

export function AuditPage() {
    const audit = useAudit();
    const meta = useMeta();
    const products = useProducts();
    const applications = useQueue({ include_closed: true });
    const [group, setGroup] = useState<Group>('all');
    const [visible, setVisible] = useState(PAGE_SIZE);

    const numbers = useMemo(
        () => new Map((applications.data ?? []).map((item) => [item.id, item.number] as const)),
        [applications.data],
    );
    const definition = GROUPS.find((item) => item.key === group) ?? GROUPS[0];
    const rows = (audit.data ?? []).filter(definition.test);
    const shown = rows.slice(0, visible);

    const chooseGroup = (next: Group) => {
        setGroup(next);
        setVisible(PAGE_SIZE);
    };

    return (
        <div className='page page--wide bank-page'>
            <PageHead title='Журнал действий' subtitle='Последние 200 действий клиентов, сотрудников банка и системы' />
            <section className='card card--tight'>
                <div className='bank-filters'>
                    <div className='chips' role='group' aria-label='Тип действия'>
                        {GROUPS.map((item) => (
                            <button
                                key={item.key}
                                type='button'
                                className={`chip${group === item.key ? ' chip--active' : ''}`}
                                aria-pressed={group === item.key}
                                onClick={() => chooseGroup(item.key)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                    <div className='row'>
                        {audit.data && <span className='bank-sub'>Записей: {rows.length}</span>}
                        <Button
                            view='secondary'
                            size={32}
                            loading={audit.isFetching}
                            onClick={() => void audit.refetch()}
                        >
                            Обновить
                        </Button>
                    </div>
                </div>
                {audit.isLoading && <Loader />}
                <ErrorPlate error={audit.error} title='Не удалось загрузить журнал' />
                {audit.data && !rows.length && <Empty title='Записей нет' text='Выберите другой тип действий' />}
                {rows.length > 0 && (
                    <div className='table-wrap'>
                        <table className='simple bank-audit'>
                            <thead>
                                <tr>
                                    <th>Время</th>
                                    <th>Пользователь</th>
                                    <th>Действие</th>
                                    <th>Объект</th>
                                    <th>Детали</th>
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((row) => {
                                    const number =
                                        row.entity_type === 'application' ? numbers.get(row.entity_id) : undefined;
                                    return (
                                        <tr key={row.id}>
                                            <td className='bank-nowrap'>{dateTime(row.created_at)}</td>
                                            <td className='bank-nowrap'>
                                                <div>{row.user ?? 'Система'}</div>
                                                <div className='bank-sub'>{ACTOR_LABELS[row.actor] ?? row.actor}</div>
                                            </td>
                                            <td>
                                                <Badge color={ACTION_COLORS[row.action] ?? 'grey'}>
                                                    {ACTION_LABELS[row.action] ?? row.action}
                                                </Badge>
                                            </td>
                                            <td className='bank-nowrap'>
                                                <div>{entityTitle(row.entity_type, row.entity_id)}</div>
                                                <div className='bank-sub'>
                                                    {number ? (
                                                        <Link
                                                            className='bank-link'
                                                            to={`/bank/applications/${row.entity_id}`}
                                                        >
                                                            № {number}
                                                        </Link>
                                                    ) : row.entity_type === 'simulator' ||
                                                      row.entity_type === 'system' ? (
                                                        row.entity_id
                                                    ) : (
                                                        `id ${shortId(row.entity_id)}`
                                                    )}
                                                </div>
                                            </td>
                                            <td>{auditDetails(row.action, row.details, meta.data, products.data)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                {rows.length > shown.length && (
                    <div className='bank-more'>
                        <span className='bank-sub'>
                            Показано {shown.length} из {rows.length}
                        </span>
                        <Button view='secondary' size={40} onClick={() => setVisible((value) => value + PAGE_SIZE)}>
                            Показать ещё
                        </Button>
                    </div>
                )}
            </section>
        </div>
    );
}
