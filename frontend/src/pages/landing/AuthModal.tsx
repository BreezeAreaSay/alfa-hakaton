import type { ReactNode } from 'react';

import { CenteredModal } from '../../components/CenteredModal';

/**
 * Окно входа или регистрации: треть ширины и две трети высоты экрана, содержимое прокручивается внутри.
 * wide — широкое окно по высоте содержимого (вход: форма и тестовые учётные записи рядом, без прокрутки).
 */
export function AuthModal({
    open,
    title,
    onClose,
    onEntered,
    wide = false,
    children,
}: {
    open: boolean;
    title: string;
    onClose: () => void;
    onEntered?: () => void;
    wide?: boolean;
    children: ReactNode;
}) {
    return (
        <CenteredModal
            open={open}
            title={title}
            onClose={onClose}
            onEntered={onEntered}
            className={wide ? 'login-modal login-modal--wide' : 'login-modal'}
            contentClassName='login-modal__content'
        >
            <div className='stack login-modal__body'>{children}</div>
        </CenteredModal>
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
