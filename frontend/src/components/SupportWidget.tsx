import { IconButton } from '@alfalab/core-components/icon-button';
import { Textarea } from '@alfalab/core-components/textarea';
import { Typography } from '@alfalab/core-components/typography';
import { ArrowLeftMIcon } from '@alfalab/icons-glyph/ArrowLeftMIcon';
import { BubbleMIcon } from '@alfalab/icons-glyph/BubbleMIcon';
import { CrossMIcon } from '@alfalab/icons-glyph/CrossMIcon';
import { SendMIcon } from '@alfalab/icons-glyph/SendMIcon';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { useReadSupport, useSendSupport, useSupportChat, useSupportThread, useSupportThreads } from '../api/hooks';
import type { ChatMessage, SupportChat } from '../api/types';
import { dateTime } from '../utils/format';
import { ErrorPlate } from './ui';

import './support.css';

/**
 * Поддержка: красная кнопка справа внизу открывает окно чата. Клиент описывает проблему, администратор
 * видит в том же окне колонку с чатами клиентов и отвечает. Обновляется по событиям SUPPORT из потока SSE.
 */
// Длительность закрытия окна — совпадает с анимацией support-out в support.css
const CLOSE_MS = 180;

/** Черновики сообщений: '' — свой чат клиента, иначе id клиента, которому отвечает администратор. */
type Drafts = Record<string, string>;

export function SupportWidget({ admin }: { admin: boolean }) {
    // Закрытое окно убирается из разметки целиком; черновики и выбранный чат живут здесь и не теряются
    const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed');
    const [drafts, setDrafts] = useState<Drafts>({});
    const [selected, setSelected] = useState<string | null>(null);
    const chat = useSupportChat(!admin);
    const threads = useSupportThreads(admin);
    const open = phase === 'open';
    const unread = admin
        ? (threads.data ?? []).reduce((sum, thread) => sum + thread.unread, 0)
        : (chat.data?.unread ?? 0);

    useEffect(() => {
        if (phase !== 'closing') return undefined;
        const timer = setTimeout(() => setPhase('closed'), CLOSE_MS);
        return () => clearTimeout(timer);
    }, [phase]);

    const close = () => setPhase('closing');
    const draft = {
        drafts,
        onDraft: (key: string, text: string) => setDrafts((current) => ({ ...current, [key]: text })),
    };

    return (
        <div className='support'>
            {phase !== 'closed' && (
                <section
                    className={`support__panel${admin ? ' support__panel--admin' : ''}${open ? '' : ' support__panel--closing'}`}
                    aria-label='Поддержка'
                    role='dialog'
                >
                    <header className='support__head'>
                        <div>
                            <Typography.Text view='primary-medium' weight='bold' tag='div'>
                                Поддержка
                            </Typography.Text>
                            <Typography.Text view='primary-small' color='secondary' tag='div'>
                                {admin ? 'Чаты клиентов' : 'Опишите проблему — ответим здесь же'}
                            </Typography.Text>
                        </div>
                        <IconButton icon={CrossMIcon} size={32} aria-label='Закрыть' onClick={close} />
                    </header>
                    {admin ? (
                        <AdminInbox open={open} selected={selected} onSelect={setSelected} {...draft} />
                    ) : (
                        <Conversation chat={chat.data} open={open} clientId={null} {...draft} />
                    )}
                </section>
            )}

            <button
                type='button'
                className='support__button'
                aria-label={open ? 'Закрыть поддержку' : 'Поддержка'}
                aria-expanded={open}
                onClick={() => (open ? close() : setPhase('open'))}
            >
                {open ? <CrossMIcon aria-hidden={true} /> : <BubbleMIcon aria-hidden={true} />}
                {unread > 0 && !open && <span className='support__badge'>{unread}</span>}
            </button>
        </div>
    );
}

/** Колонка с чатами клиентов и выбранная переписка; на телефоне — по очереди, с кнопкой «Все чаты». */
function AdminInbox({
    open,
    selected,
    onSelect,
    drafts,
    onDraft,
}: {
    open: boolean;
    selected: string | null;
    onSelect: (clientId: string | null) => void;
    drafts: Drafts;
    onDraft: (key: string, text: string) => void;
}) {
    const threads = useSupportThreads(true);
    const thread = useSupportThread(selected);
    const current = threads.data?.find((t) => t.client_id === selected);

    return (
        <div className={`support__inbox${selected ? ' support__inbox--selected' : ''}`}>
            <ul className='support__threads' aria-label='Чаты'>
                {!threads.data?.length && (
                    <li className='support__empty'>
                        <Typography.Text view='primary-small' color='secondary'>
                            Пока никто не писал в поддержку.
                        </Typography.Text>
                    </li>
                )}
                {threads.data?.map((t) => (
                    <li key={t.client_id}>
                        <button
                            type='button'
                            className={`support__thread${t.client_id === selected ? ' support__thread--active' : ''}`}
                            aria-current={t.client_id === selected}
                            onClick={() => onSelect(t.client_id)}
                        >
                            <span className='support__thread-top'>
                                <span className='support__thread-name'>{t.client_name}</span>
                                {t.unread > 0 && <span className='support__thread-badge'>{t.unread}</span>}
                            </span>
                            {t.company_name && <span className='support__thread-company'>{t.company_name}</span>}
                            <span className='support__thread-text'>
                                {t.last_author_role === 'CLIENT' ? '' : 'Вы: '}
                                {t.last_text}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            <div className='support__chat'>
                {selected && current ? (
                    <>
                        <div className='support__chat-head'>
                            <IconButton
                                icon={ArrowLeftMIcon}
                                size={32}
                                aria-label='Все чаты'
                                className='support__back'
                                onClick={() => onSelect(null)}
                            />
                            <div>
                                <Typography.Text view='primary-small' weight='bold' tag='div'>
                                    {current.client_name}
                                </Typography.Text>
                                {current.company_name && (
                                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                                        {current.company_name}
                                    </Typography.Text>
                                )}
                            </div>
                        </div>
                        <Conversation
                            chat={thread.data}
                            open={open}
                            clientId={selected}
                            drafts={drafts}
                            onDraft={onDraft}
                        />
                    </>
                ) : (
                    <div className='support__empty support__empty--center'>
                        <Typography.Text view='primary-small' color='secondary'>
                            Выберите чат слева, чтобы прочитать вопрос и ответить.
                        </Typography.Text>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Переписка и поле ввода. clientId = null — клиент пишет в свой чат, иначе администратор отвечает клиенту.
 * Пока окно открыто, входящие сразу отмечаются прочитанными. Enter — отправить, Shift+Enter — новая строка.
 */
function Conversation({
    chat,
    open,
    clientId,
    drafts,
    onDraft,
}: {
    chat: SupportChat | undefined;
    open: boolean;
    clientId: string | null;
    drafts: Drafts;
    onDraft: (key: string, text: string) => void;
}) {
    const send = useSendSupport(clientId);
    const read = useReadSupport(clientId);
    const text = drafts[clientId ?? ''] ?? '';
    const setText = (value: string) => onDraft(clientId ?? '', value);
    const list = useRef<HTMLDivElement>(null);
    const unread = chat?.unread ?? 0;

    useEffect(() => {
        list.current?.scrollTo({ top: list.current.scrollHeight });
    }, [chat?.messages.length, open]);

    // read — новый объект на каждом рендере, поэтому не в зависимостях: отмечаем по факту непрочитанных
    useEffect(() => {
        if (open && unread > 0 && !read.isPending) read.mutate();
    }, [open, unread, clientId]);

    const submit = async () => {
        const value = text.trim();
        if (!value || send.isPending) return;
        await send.mutateAsync(value);
        setText('');
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
        }
    };

    // своё сообщение — справа: у клиента свои, у администратора — ответы поддержки
    const mine = (message: ChatMessage) =>
        clientId ? message.author_role !== 'CLIENT' : message.author_role === 'CLIENT';

    return (
        <>
            <div className='support__messages' ref={list}>
                {!chat?.messages.length && (
                    <Typography.Text view='primary-small' color='secondary' tag='p'>
                        {clientId
                            ? 'Сообщений пока нет.'
                            : 'Здесь пока пусто. Напишите, что случилось, — администратор ответит в этом окне.'}
                    </Typography.Text>
                )}
                {chat?.messages.map((m) => (
                    <div key={m.id} className={`bubble${mine(m) ? ' bubble--mine' : ''}`}>
                        <div className='support__meta'>
                            {m.author_role === 'CLIENT' ? m.author_name : 'Поддержка'} · {dateTime(m.created_at)}
                        </div>
                        {m.text}
                    </div>
                ))}
            </div>
            <ErrorPlate error={send.error} title='Не удалось отправить' />
            <div className='support__compose'>
                <Textarea
                    label={clientId ? 'Ответ клиенту' : 'Опишите проблему'}
                    labelView='inner'
                    size={56}
                    block={true}
                    minRows={1}
                    maxRows={4}
                    maxLength={4000}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    name='support-message'
                />
                <button
                    type='button'
                    className='support__send'
                    aria-label='Отправить'
                    disabled={!text.trim() || send.isPending}
                    onClick={() => void submit()}
                >
                    <SendMIcon aria-hidden={true} />
                </button>
            </div>
        </>
    );
}
