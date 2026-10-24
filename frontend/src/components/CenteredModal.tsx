import { ModalDesktop } from '@alfalab/core-components/modal/desktop';
import type { ReactNode } from 'react';

// Длительность выезда окна и размытия фона — совпадает с переходами .login-modal и .login-backdrop в global.css
const TRANSITION_MS = 320;

/**
 * Окно по центру экрана поверх размытой страницы: выезжает снизу, закрывается крестиком, Esc и кликом по фону.
 * Общее для окон входа, регистрации и подтверждения выхода; размер задаёт className. Название окна —
 * его доступное имя (по нему окно находят сценарии в браузере).
 */
export function CenteredModal({
    open,
    title,
    onClose,
    onEntered,
    className,
    contentClassName,
    titleAlign = 'left',
    children,
}: {
    open: boolean;
    title: string;
    onClose: () => void;
    onEntered?: () => void;
    className: string;
    contentClassName?: string;
    titleAlign?: 'left' | 'center';
    children: ReactNode;
}) {
    return (
        <ModalDesktop
            open={open}
            onClose={onClose}
            className={className}
            wrapperClassName='login-modal__wrapper'
            contentClassName={contentClassName}
            scrollHandler='content'
            wrapperProps={{ 'aria-label': title }}
            transitionProps={{ classNames: 'login-modal', timeout: TRANSITION_MS, onEntered }}
            backdropProps={{
                className: 'login-backdrop',
                transitionClassNames: 'login-backdrop',
                timeout: TRANSITION_MS,
            }}
        >
            <ModalDesktop.Header hasCloser={true} sticky={true} title={title} align={titleAlign} />
            <ModalDesktop.Content>{children}</ModalDesktop.Content>
        </ModalDesktop>
    );
}
