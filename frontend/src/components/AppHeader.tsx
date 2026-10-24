import { ButtonDesktop } from '@alfalab/core-components/button/desktop';
import { IconButton } from '@alfalab/core-components/icon-button';
import { Typography } from '@alfalab/core-components/typography';
import { AlfaBankLIcon } from '@alfalab/icons-logotype/AlfaBankLIcon';
import { BellMIcon } from '@alfalab/icons-glyph/BellMIcon';
import { DoorOpenMIcon } from '@alfalab/icons-glyph/DoorOpenMIcon';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';

import { useMarkRead, useNotifications } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { dateTime } from '../utils/format';
import { CenteredModal } from './CenteredModal';

export interface NavItem {
    to: string;
    label: string;
    /** короткая подпись для телефона, где полная не помещается */
    short?: string;
    /** пункт только для широких экранов: на телефоне в шапке помещаются два-три пункта */
    wideOnly?: boolean;
    end?: boolean;
}

/** Знак банка и название кабинета в шапке; ведёт на главную раздела. */
export function Logo({ home, bank = false }: { home: string; bank?: boolean }) {
    const brand = 'Альфа-Банк';
    const title = bank ? 'Кредитный конвейер' : 'Кредитный кабинет';
    const subtitle = bank ? 'Рабочее место аналитика' : 'для бизнеса';
    return (
        /* Имя ссылки: знак банка, весь видимый текст и назначение (WCAG 2.5.3 «Метка в имени»). Сам знак
           скрыт от вспомогательных технологий: его подпись склеивалась бы с текстом ссылки без пробела. */
        <Link to={home} className='logo' aria-label={`${brand} ${title} ${subtitle} — на главную`}>
            <span className='logo__mark'>
                <AlfaBankLIcon width={21} height={32} aria-hidden={true} />
            </span>
            <span>
                {/* пробел между строками: без него их текст склеивается в одно слово при чтении вслух и копировании */}
                <Typography.Text view='primary-medium' weight='bold' tag='div'>
                    {title}
                </Typography.Text>{' '}
                <Typography.Text view='primary-small' color='secondary' tag='div'>
                    {subtitle}
                </Typography.Text>
            </span>
        </Link>
    );
}

export function AppHeader({ nav, home, bank = false }: { nav: NavItem[]; home: string; bank?: boolean }) {
    const { user } = useAuth();
    const [confirmExit, setConfirmExit] = useState(false);
    return (
        <header className={`header${bank ? ' header--bank' : ''}`}>
            <div className='header__inner'>
                <Logo home={home} bank={bank} />
                <nav className='nav' aria-label='Разделы'>
                    {nav.map((item) => (
                        <NavLink
                            key={item.to}
                            to={item.to}
                            end={item.end}
                            className={({ isActive }) =>
                                `nav__link${isActive ? ' nav__link--active' : ''}${item.wideOnly ? ' nav__link--wide' : ''}`
                            }
                        >
                            {item.short ? (
                                <>
                                    <span className='nav__label'>{item.label}</span>
                                    <span className='nav__label--short'>{item.short}</span>
                                </>
                            ) : (
                                item.label
                            )}
                        </NavLink>
                    ))}
                </nav>
                <div className='header__right'>
                    <NotificationsBell />
                    <div className='header__user'>
                        <Typography.Text view='primary-small' weight='medium' tag='div'>
                            {user?.full_name}
                        </Typography.Text>
                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                            {user?.company?.name ?? user?.position}
                        </Typography.Text>
                    </div>
                    <button
                        type='button'
                        className='header__exit'
                        aria-label='Выйти'
                        title='Выйти'
                        onClick={() => setConfirmExit(true)}
                    >
                        <DoorOpenMIcon aria-hidden={true} />
                    </button>
                </div>
            </div>
            <ExitConfirm open={confirmExit} onClose={() => setConfirmExit(false)} />
        </header>
    );
}

/** Подтверждение выхода — по центру экрана, как окно входа; выход — только по кнопке «Выйти» в окне. */
function ExitConfirm({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { logout } = useAuth();
    const navigate = useNavigate();
    const exit = () => {
        logout();
        navigate('/login');
    };
    return (
        <CenteredModal open={open} title='Выйти из кабинета?' onClose={onClose} className='confirm-modal'>
            <div className='stack'>
                <Typography.Text view='primary-medium' color='secondary' tag='p'>
                    Чтобы вернуться, понадобится снова ввести логин и пароль.
                </Typography.Text>
                <div className='confirm-modal__actions'>
                    <ButtonDesktop view='secondary' size={48} block={true} onClick={onClose}>
                        Остаться
                    </ButtonDesktop>
                    <ButtonDesktop view='primary' size={48} block={true} onClick={exit}>
                        Выйти
                    </ButtonDesktop>
                </div>
            </div>
        </CenteredModal>
    );
}

function NotificationsBell() {
    const { user } = useAuth();
    const { data } = useNotifications();
    const markRead = useMarkRead();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return undefined;
        const close = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && data?.unread) markRead.mutate();
    };

    const base = user?.role === 'CLIENT' ? '/client/applications' : '/bank/applications';
    return (
        // Без новых уведомлений колокольчик серый, с новыми — красный и «звенит», чтобы захотелось проверить
        <div className={`bell${data?.unread ? ' bell--unread' : ''}`} ref={ref}>
            <IconButton
                icon={<BellMIcon aria-hidden={true} />}
                colors='inverted'
                aria-label={data?.unread ? `Уведомления, новых: ${data.unread}` : 'Уведомления'}
                title='Уведомления'
                onClick={toggle}
            />
            {Boolean(data?.unread) && <span className='bell__count'>{data?.unread}</span>}
            {open && (
                <div
                    role='dialog'
                    aria-label='Уведомления'
                    className='notifications'
                    style={{
                        position: 'absolute',
                        right: 0,
                        top: 48,
                        width: 380,
                        maxHeight: 480,
                        overflowY: 'auto',
                        background: 'var(--color-light-base-bg-primary)',
                        borderRadius: 20,
                        boxShadow: 'var(--shadow-l, 0 8px 32px rgba(0,0,0,0.16))',
                        padding: 8,
                        zIndex: 100,
                    }}
                >
                    <Typography.Text view='primary-medium' weight='bold' tag='div' style={{ padding: '12px 12px 8px' }}>
                        Уведомления
                    </Typography.Text>
                    {!data?.items.length && (
                        <Typography.Text view='primary-small' color='secondary' tag='div' style={{ padding: 12 }}>
                            Пока ничего нового
                        </Typography.Text>
                    )}
                    {data?.items.map((item) => (
                        <button
                            key={item.id}
                            type='button'
                            className='demo-account'
                            style={{
                                width: '100%',
                                marginBottom: 4,
                                background: item.unread ? 'var(--color-light-base-bg-secondary)' : 'transparent',
                            }}
                            onClick={() => {
                                setOpen(false);
                                if (item.application_id) navigate(`${base}/${item.application_id}`);
                            }}
                        >
                            <Typography.Text view='primary-small' weight='medium' tag='div'>
                                {item.title}
                            </Typography.Text>
                            {item.body && (
                                <Typography.Text view='primary-small' color='secondary' tag='div'>
                                    {item.body}
                                </Typography.Text>
                            )}
                            <Typography.Text view='primary-small' color='secondary' tag='div'>
                                {dateTime(item.created_at)}
                            </Typography.Text>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
