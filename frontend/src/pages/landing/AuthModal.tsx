import { ModalDesktop } from '@alfalab/core-components/modal/desktop';
import type { ReactNode } from 'react';

// Длительность выезда окна и размытия фона — совпадает с переходами .login-modal и .login-backdrop в global.css
const TRANSITION_MS = 320;

/**
 * Окно входа или регистрации: по центру экрана, треть ширины и две трети высоты, выезжает снизу поверх
 * размытой страницы. Название окна — его доступное имя (по нему окно находят сценарии в браузере).
 */
export function AuthModal({
    open,
    title,
    onClose,
    onEntered,
    children,
}: {
    open: boolean;
    title: string;
    onClose: () => void;
    onEntered?: () => void;
    children: ReactNode;
}) {
    return (
        <ModalDesktop
            open={open}
            onClose={onClose}
            className='login-modal'
            wrapperClassName='login-modal__wrapper'
            contentClassName='login-modal__content'
            scrollHandler='content'
            wrapperProps={{ 'aria-label': title }}
            transitionProps={{ classNames: 'login-modal', timeout: TRANSITION_MS, onEntered }}
            backdropProps={{
                className: 'login-backdrop',
                transitionClassNames: 'login-backdrop',
                timeout: TRANSITION_MS,
            }}
        >
            <ModalDesktop.Header hasCloser={true} sticky={true} title={title} />
            <ModalDesktop.Content>
                <div className='stack login-modal__body'>{children}</div>
            </ModalDesktop.Content>
        </ModalDesktop>
    );
}

/** Строка внизу окна: «Нет профиля? Создать» / «Уже есть профиль? Войти». */
export function AuthSwitch({ text, action, onClick }: { text: string; action: string; onClick: () => void }) {
    return (
        <p className='login-modal__switch'>
            {text}{' '}
            <button type='button' className='login-modal__link' onClick={onClick}>
                {action}
            </button>
        </p>
    );
}
