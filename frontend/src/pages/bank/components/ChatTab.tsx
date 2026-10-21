import { Button } from '@alfalab/core-components/button';
import { Textarea } from '@alfalab/core-components/textarea';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { useMessages, useSendMessage } from '../../../api/hooks';
import type { Application } from '../../../api/types';
import { Empty, ErrorPlate, Loader } from '../../../components/ui';
import { dateTime } from '../../../utils/format';
import { Card } from './common';

export function ChatTab({ app }: { app: Application }) {
    const available = app.status !== 'DRAFT';
    const messages = useMessages(app.id, available);
    const send = useSendMessage(app.id);
    const [text, setText] = useState('');
    const listRef = useRef<HTMLDivElement>(null);
    const count = messages.data?.length ?? 0;

    useEffect(() => {
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight;
    }, [count]);

    const submit = () => {
        const value = text.trim();
        if (!value || send.isPending) return;
        send.mutate(value, { onSuccess: () => setText('') });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
        }
    };

    if (!available) {
        return (
            <Card title='Чат с клиентом'>
                <Empty title='Чат недоступен' text='Переписка откроется, когда клиент отправит заявку' />
            </Card>
        );
    }

    return (
        <Card
            title='Чат с клиентом'
            extra={count > 0 ? <span className='bank-sub'>Сообщений: {count}</span> : undefined}
        >
            <div className='stack-16'>
                {messages.isLoading && <Loader />}
                <ErrorPlate error={messages.error} title='Не удалось загрузить сообщения' />
                {messages.data && !count && (
                    <Empty title='Сообщений пока нет' text='Напишите клиенту, если нужно что-то уточнить по заявке' />
                )}
                {count > 0 && (
                    <div className='chat bank-chat' ref={listRef}>
                        {messages.data?.map((message) => (
                            <div
                                key={message.id}
                                className={`bubble${message.author_role !== 'CLIENT' ? ' bubble--mine' : ''}`}
                            >
                                {message.text}
                                <div className='bank-bubble-meta'>
                                    {message.author_name} · {dateTime(message.created_at)}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <Textarea
                    label='Сообщение клиенту'
                    labelView='inner'
                    size={56}
                    block={true}
                    minRows={2}
                    maxRows={6}
                    autosize={true}
                    maxLength={4000}
                    value={text}
                    onChange={(_, { value }) => setText(value)}
                    onKeyDown={onKeyDown}
                />
                <ErrorPlate error={send.error} title='Сообщение не отправлено' />
                <div className='row row--between'>
                    <span className='bank-sub'>Ctrl + Enter — отправить. Клиент увидит сообщение в кабинете.</span>
                    <Button view='primary' size={40} onClick={submit} loading={send.isPending} disabled={!text.trim()}>
                        Отправить
                    </Button>
                </div>
            </div>
        </Card>
    );
}
