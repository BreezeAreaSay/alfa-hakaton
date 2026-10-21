import { Button } from '@alfalab/core-components/button';
import { DocumentLinesMIcon } from '@alfalab/icons-glyph/DocumentLinesMIcon';
import { useState } from 'react';

import { openInNewTab } from '../../../api/client';
import type { Application, DocumentItem, StatementSummary } from '../../../api/types';
import { Badge, Empty, ErrorPlate } from '../../../components/ui';
import { date, dateTime, fileSize, rub } from '../../../utils/format';
import { Card } from './common';
import { InflowChart } from './InflowChart';

const SOURCE_LABELS: Record<DocumentItem['source'], string> = {
    CLIENT: 'загрузил клиент',
    BANK: 'загрузил банк',
    GENERATED: 'сформирован системой',
};

const SIGNED_KINDS = new Set(['AGREEMENT', 'SCHEDULE']);

function Statement({ parsed }: { parsed: StatementSummary }) {
    return (
        <div className='bank-statement stack-16'>
            <dl className='bank-inline-facts'>
                <div>
                    <dt>Период</dt>
                    <dd>
                        {date(parsed.period_from)} — {date(parsed.period_to)}
                    </dd>
                </div>
                <div>
                    <dt>Операций</dt>
                    <dd>{parsed.operations}</dd>
                </div>
                <div>
                    <dt>Поступления в среднем за месяц</dt>
                    <dd>{rub(parsed.avg_monthly_inflow)}</dd>
                </div>
                <div>
                    <dt>Всего поступлений</dt>
                    <dd>{rub(parsed.total_inflow)}</dd>
                </div>
                {parsed.account && (
                    <div>
                        <dt>Счёт</dt>
                        <dd>{parsed.account}</dd>
                    </div>
                )}
                <div>
                    <dt>Формат</dt>
                    <dd>{parsed.source === '1C' ? '1С' : parsed.source}</dd>
                </div>
            </dl>
            {parsed.months.length > 0 && (
                <InflowChart
                    months={parsed.months.map((m) => ({ month: m.month, inflow: m.inflow }))}
                    title='Поступления по выписке по месяцам'
                />
            )}
        </div>
    );
}

export function DocumentsTab({ app }: { app: Application }) {
    const [error, setError] = useState<unknown>(null);
    const [opening, setOpening] = useState<string | null>(null);

    const open = async (doc: DocumentItem) => {
        setError(null);
        setOpening(doc.id);
        try {
            await openInNewTab(`/api/documents/${doc.id}/download`);
        } catch (e) {
            setError(e);
        } finally {
            setOpening(null);
        }
    };

    if (!app.documents.length) {
        return (
            <Card title='Документы'>
                <Empty
                    title='Документов пока нет'
                    text='Здесь появятся выписки и файлы клиента, а после одобрения — договор'
                />
            </Card>
        );
    }

    return (
        <Card title='Документы' extra={<span className='bank-sub'>Файлов: {app.documents.length}</span>}>
            <ErrorPlate error={error} title='Не удалось открыть файл' />
            <div className='bank-docs'>
                {app.documents.map((doc) => (
                    <div key={doc.id} className='bank-doc'>
                        <span className='bank-doc__icon' aria-hidden={true}>
                            <DocumentLinesMIcon width={24} height={24} />
                        </span>
                        <div className='bank-doc__body stack-8'>
                            <div>
                                <div className='bank-strong'>{doc.kind_label}</div>
                                <div className='bank-sub'>
                                    {doc.file_name} · {fileSize(doc.size)} · {dateTime(doc.created_at)} ·{' '}
                                    {SOURCE_LABELS[doc.source]}
                                </div>
                            </div>
                            {(SIGNED_KINDS.has(doc.kind) || doc.signed_by_client || doc.signed_by_bank) && (
                                <div className='row bank-row-tight'>
                                    <Badge color={doc.signed_by_client ? 'green' : 'grey'}>
                                        {doc.signed_by_client ? 'Подписан клиентом' : 'Клиент не подписал'}
                                    </Badge>
                                    <Badge color={doc.signed_by_bank ? 'green' : 'grey'}>
                                        {doc.signed_by_bank ? 'Подписан банком' : 'Банк не подписал'}
                                    </Badge>
                                </div>
                            )}
                            {doc.parsed && <Statement parsed={doc.parsed} />}
                        </div>
                        <Button view='secondary' size={40} loading={opening === doc.id} onClick={() => void open(doc)}>
                            Открыть
                        </Button>
                    </div>
                ))}
            </div>
        </Card>
    );
}
