import { IconButton } from '@alfalab/core-components/icon-button';
import { Typography } from '@alfalab/core-components/typography';
import { DocumentPdfMIcon } from '@alfalab/icons-glyph/DocumentPdfMIcon';
import { DocumentTxtMIcon } from '@alfalab/icons-glyph/DocumentTxtMIcon';
import { EyeMIcon } from '@alfalab/icons-glyph/EyeMIcon';
import { TrashCanLineMIcon } from '@alfalab/icons-glyph/TrashCanLineMIcon';

import { openInNewTab } from '../../../api/client';
import type { DocumentItem } from '../../../api/types';
import { CashflowForecast } from '../../../components/CashflowForecast';
import { Badge } from '../../../components/ui';
import { date, fileSize, rub } from '../../../utils/format';

export function DocumentList({
    documents,
    onDelete,
}: {
    documents: DocumentItem[];
    onDelete?: (document: DocumentItem) => void;
}) {
    if (!documents.length) return null;
    return (
        <div className='stack-8'>
            {documents.map((doc) => (
                <div key={doc.id} className='tile row doc-item' style={{ padding: '12px 16px' }}>
                    {doc.content_type === 'application/pdf' ? <DocumentPdfMIcon /> : <DocumentTxtMIcon />}
                    <div className='doc-item__body'>
                        <Typography.Text
                            view='primary-small'
                            weight='medium'
                            tag='div'
                            style={{ overflowWrap: 'anywhere' }}
                        >
                            {doc.file_name}
                        </Typography.Text>
                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                            {doc.kind_label} · {fileSize(doc.size)} · {date(doc.created_at)}
                        </Typography.Text>
                        {doc.parsed && (
                            <Typography.Text view='primary-small' color='positive' tag='div'>
                                Распознали выписку: {doc.parsed.months.length} мес., в среднем{' '}
                                {rub(doc.parsed.avg_monthly_inflow)} поступлений в месяц
                            </Typography.Text>
                        )}
                        {(doc.signed_by_client || doc.signed_by_bank) && (
                            <div className='row' style={{ gap: 6, marginTop: 4 }}>
                                {doc.signed_by_client && <Badge color='green'>подписан вами</Badge>}
                                {doc.signed_by_bank && <Badge color='green'>подписан банком</Badge>}
                            </div>
                        )}
                        {doc.parsed && (
                            <div style={{ marginTop: 12 }}>
                                <CashflowForecast forecast={doc.parsed.forecast} compact={true} />
                            </div>
                        )}
                    </div>
                    <div className='doc-item__actions'>
                        <IconButton
                            icon={EyeMIcon}
                            aria-label='Открыть'
                            title='Открыть'
                            onClick={() => void openInNewTab(`/api/documents/${doc.id}/download`)}
                        />
                        {onDelete && doc.source === 'CLIENT' && (
                            <IconButton
                                icon={TrashCanLineMIcon}
                                aria-label='Удалить'
                                title='Удалить'
                                onClick={() => onDelete(doc)}
                            />
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}
