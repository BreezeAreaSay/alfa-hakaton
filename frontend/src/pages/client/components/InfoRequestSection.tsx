import { Button } from '@alfalab/core-components/button';
import { Textarea } from '@alfalab/core-components/textarea';
import { Typography } from '@alfalab/core-components/typography';
import { useState } from 'react';

import { useAnswer, useDeleteDocument, useUpload } from '../../../api/hooks';
import type { Application, InfoRequest } from '../../../api/types';
import { ErrorPlate } from '../../../components/ui';
import { dateTime, timeLeft } from '../../../utils/format';
import { DocumentList } from './DocumentList';
import { UploadButton } from './UploadButton';

export function InfoRequestSection({ application, request }: { application: Application; request: InfoRequest }) {
    const [text, setText] = useState('');
    const upload = useUpload();
    const remove = useDeleteDocument();
    const answer = useAnswer();
    const attached = application.documents.filter((d) => d.info_request_id === request.id);
    const needsStatement = request.items.some((item) => item.code === 'BANK_STATEMENT');

    return (
        <section className='card stack'>
            <div className='stack-8'>
                <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                    Банку нужна информация
                </Typography.Title>
                <Typography.Text view='primary-medium' color='secondary' tag='p'>
                    {request.origin === 'SYSTEM'
                        ? 'Чтобы принять решение, не хватает данных. После ответа проверка продолжится автоматически.'
                        : 'Специалист банка просит дополнить заявку. После ответа он продолжит рассмотрение.'}
                </Typography.Text>
            </div>
            {request.comment && (
                <div className='tile'>
                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                        Комментарий банка
                    </Typography.Text>
                    <Typography.Text view='primary-medium' tag='div'>
                        {request.comment}
                    </Typography.Text>
                </div>
            )}
            <ol className='stack-16' style={{ margin: 0, paddingLeft: 20 }}>
                {request.items.map((item) => (
                    <li key={item.code}>
                        <Typography.Text view='primary-medium' weight='medium' tag='div'>
                            {item.title}
                        </Typography.Text>
                        {item.hint && (
                            <Typography.Text view='primary-small' color='secondary' tag='div'>
                                {item.hint}
                            </Typography.Text>
                        )}
                    </li>
                ))}
            </ol>
            <DocumentList documents={attached} onDelete={(doc) => remove.mutate(doc.id)} />
            <div className='row'>
                {needsStatement && (
                    <UploadButton
                        accept='.txt,.csv'
                        view='primary'
                        loading={upload.isPending && upload.variables?.kind === 'BANK_STATEMENT'}
                        onFile={(file) =>
                            upload.mutate({
                                id: application.id,
                                file,
                                kind: 'BANK_STATEMENT',
                                infoRequestId: request.id,
                            })
                        }
                    >
                        Прикрепить выписку
                    </UploadButton>
                )}
                <UploadButton
                    loading={upload.isPending && upload.variables?.kind === 'OTHER'}
                    onFile={(file) =>
                        upload.mutate({ id: application.id, file, kind: 'OTHER', infoRequestId: request.id })
                    }
                >
                    Прикрепить документ
                </UploadButton>
                {needsStatement && (
                    <a href={`${import.meta.env.BASE_URL}demo-files/vypiska_orlov_1c.txt`} download={true}>
                        <Typography.Text view='primary-small' color='secondary'>
                            Скачать тестовую выписку
                        </Typography.Text>
                    </a>
                )}
            </div>
            <ErrorPlate error={upload.error} title='Файл не загружен' />
            <Textarea
                label='Ответ или пояснение'
                labelView='inner'
                size={56}
                block={true}
                minRows={2}
                maxLength={2000}
                value={text}
                onChange={(e) => setText(e.target.value)}
            />
            <Typography.Text view='primary-small' color='secondary' tag='p'>
                Ответить нужно до {dateTime(request.due_at)} ({timeLeft(request.due_at)}).
            </Typography.Text>
            <ErrorPlate error={answer.error} title='Ответ не отправлен' />
            <div>
                <Button
                    view='primary'
                    size={56}
                    loading={answer.isPending}
                    disabled={!attached.length && !text.trim()}
                    onClick={() => answer.mutate({ requestId: request.id, text: text.trim() || null })}
                >
                    Отправить ответ
                </Button>
            </div>
        </section>
    );
}
