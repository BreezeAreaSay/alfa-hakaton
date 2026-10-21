import { Button } from '@alfalab/core-components/button';
import { Textarea } from '@alfalab/core-components/textarea';
import { Typography } from '@alfalab/core-components/typography';
import { useEffect, useRef, useState } from 'react';

import { useMessages, useSendMessage } from '../../../api/hooks';
import type { Role } from '../../../api/types';
import { ErrorPlate } from '../../../components/ui';
import { dateTime } from '../../../utils/format';

export function ChatCard({ applicationId, viewerRole, title = 'Вопросы по заявке' }: { applicationId: string; viewerRole: Role; title?: string }) {
    const messages = useMessages(applicationId);
    const send = useSendMessage(applicationId);
    const [text, setText] = useState('');
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        list.current?.scrollTo({ top: list.current.scrollHeight });
    }, [messages.data?.length]);

    const mine = (role: Role) => (viewerRole === 'CLIENT' ? role === 'CLIENT' : role !== 'CLIENT');

    const submit = async () => {
        if (!text.trim()) return;
        await send.mutateAsync(text.trim());
        setText('');
    };

    return (
        <section className='card card--tight stack-16'>
            <Typography.Text view='primary-large' weight='bold' tag='div'>
                {title}
            </Typography.Text>
            <div className='chat' ref={list}>
                {!messages.data?.length && (
                    <Typography.Text view='primary-small' color='secondary'>
                        {viewerRole === 'CLIENT'
                            ? 'Здесь можно задать вопрос специалисту банка — ответ придёт в кабинет.'
                            : 'Сообщений пока нет.'}
                    </Typography.Text>
                )}
                {messages.data?.map((m) => (
                    <div key={m.id} className={`bubble${mine(m.author_role) ? ' bubble--mine' : ''}`}>
                        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
                            {m.author_role === 'CLIENT' ? m.author_name : `${m.author_name}, банк`} · {dateTime(m.created_at)}
                        </div>
                        {m.text}
                    </div>
                ))}
            </div>
            <Textarea
                label='Сообщение'
                labelView='inner'
                size={56}
                block={true}
                minRows={1}
                maxLength={4000}
                value={text}
                onChange={(e) => setText(e.target.value)}
            />
            <ErrorPlate error={send.error} />
            <div>
                <Button view='secondary' size={40} onClick={submit} loading={send.isPending} disabled={!text.trim()}>
                    Отправить
                </Button>
            </div>
        </section>
    );
}
