import { Typography } from '@alfalab/core-components/typography';

import type { AppStatus, Dossier, Meta, Product } from '../../../api/types';
import { Badge, Empty } from '../../../components/ui';
import { dateTime } from '../../../utils/format';
import { ACTION_COLORS, ACTION_LABELS, auditDetails } from './audit';
import { ACTOR_LABELS, Card } from './common';

const LAST_DOT: Partial<Record<AppStatus, string>> = {
    ISSUED: 'timeline__dot--done',
    REJECTED: 'timeline__dot--failed',
    NEED_INFO: 'timeline__dot--waiting',
    DECLINED: 'timeline__dot--skipped',
    CANCELLED: 'timeline__dot--skipped',
    EXPIRED: 'timeline__dot--skipped',
};

export function HistoryTab({
    data,
    meta,
    products,
}: {
    data: Dossier;
    meta: Meta | undefined;
    products: Product[] | undefined;
}) {
    const history = data.application.history;
    return (
        <div className='stack'>
            <Card title='История статусов'>
                {history.length ? (
                    <ol className='timeline'>
                        {history.map((item, index) => {
                            const last = index === history.length - 1;
                            const dot = last
                                ? (LAST_DOT[item.to_status] ?? 'timeline__dot--active')
                                : 'timeline__dot--skipped';
                            return (
                                <li key={index} className='timeline__item'>
                                    <span className={`timeline__dot ${dot}`} />
                                    <div>
                                        <Typography.Text view='primary-medium' weight='medium' tag='div'>
                                            {item.to_label}
                                        </Typography.Text>
                                        <div className='bank-sub'>
                                            {item.actor_name ?? ACTOR_LABELS[item.actor] ?? item.actor} ·{' '}
                                            {dateTime(item.created_at)}
                                        </div>
                                        {item.reason && <div className='bank-sub bank-reason'>{item.reason}</div>}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                ) : (
                    <Empty title='История пуста' />
                )}
            </Card>
            <Card
                title='Журнал действий по заявке'
                extra={<span className='bank-sub'>Записей: {data.audit.length}</span>}
            >
                {data.audit.length ? (
                    <div className='table-wrap'>
                        <table className='simple'>
                            <thead>
                                <tr>
                                    <th>Время</th>
                                    <th>Кто</th>
                                    <th>Действие</th>
                                    <th>Подробности</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.audit.map((row, index) => (
                                    <tr key={index}>
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
                                        <td>{auditDetails(row.action, row.details, meta, products)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <Empty title='Записей нет' />
                )}
            </Card>
        </div>
    );
}
