import { ButtonDesktop } from '@alfalab/core-components/button/desktop';
import { Checkbox } from '@alfalab/core-components/checkbox';
import { Input } from '@alfalab/core-components/input';
import { PasswordInput } from '@alfalab/core-components/password-input';
import { Plate } from '@alfalab/core-components/plate';
import { Typography } from '@alfalab/core-components/typography';
import { type FormEvent, useRef, useState } from 'react';

import { AuthModal, AuthSwitch } from './AuthModal';

const EMPTY = { inn: '', fullName: '', phone: '', email: '', password: '', repeat: '' };

/**
 * Окно регистрации — пока только интерфейс: профиль не создаётся и данные никуда не уходят. По организаторам
 * (ответы 3 и 9) рассматривается действующий клиент банка, поэтому вход — под тестовыми учётными записями.
 * Введённое хранится снаружи окна и не теряется при закрытии, как в окне входа.
 */
export function RegisterWidget({
    open,
    onClose,
    onLogin,
}: {
    open: boolean;
    onClose: () => void;
    onLogin: () => void;
}) {
    const innInput = useRef<HTMLInputElement>(null);
    const [form, setForm] = useState(EMPTY);
    const [consent, setConsent] = useState(false);
    const [sent, setSent] = useState(false);

    const field = (key: keyof typeof EMPTY) => ({
        value: form[key],
        onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }),
    });

    const submit = (event: FormEvent) => {
        event.preventDefault();
        setSent(true);
    };

    return (
        <AuthModal open={open} title='Регистрация' onClose={onClose} onEntered={() => innInput.current?.focus()}>
            <Typography.Text view='primary-medium' color='secondary' tag='p'>
                Профиль компании или ИП для входа в кредитный кабинет.
            </Typography.Text>
            {/* noValidate: без логики регистрации браузерные подсказки к полям не нужны */}
            <form className='stack-16' onSubmit={submit} noValidate={true}>
                <Input
                    ref={innInput}
                    label='ИНН компании или ИП'
                    labelView='inner'
                    size={56}
                    block={true}
                    inputMode='numeric'
                    autoComplete='off'
                    name='inn'
                    {...field('inn')}
                />
                <Input
                    label='Фамилия, имя и отчество'
                    labelView='inner'
                    size={56}
                    block={true}
                    autoComplete='name'
                    name='full-name'
                    {...field('fullName')}
                />
                <Input
                    label='Мобильный телефон'
                    labelView='inner'
                    size={56}
                    block={true}
                    type='tel'
                    autoComplete='tel'
                    name='phone'
                    {...field('phone')}
                />
                <Input
                    label='Электронная почта'
                    labelView='inner'
                    size={56}
                    block={true}
                    type='email'
                    autoComplete='email'
                    name='email'
                    {...field('email')}
                />
                <PasswordInput
                    label='Придумайте пароль'
                    labelView='inner'
                    size={56}
                    block={true}
                    autoComplete='new-password'
                    name='new-password'
                    {...field('password')}
                />
                <PasswordInput
                    label='Повторите пароль'
                    labelView='inner'
                    size={56}
                    block={true}
                    autoComplete='new-password'
                    name='repeat-password'
                    {...field('repeat')}
                />
                <Checkbox
                    checked={consent}
                    onChange={(_, { checked }) => setConsent(checked)}
                    label='Согласие на обработку персональных данных'
                    size={24}
                    block={true}
                />
                {sent && (
                    <Plate view='attention' rounded={true} title='Регистрация появится позже' limitContentWidth={false}>
                        В прототипе профиль пока не создаётся. Войдите под тестовой учётной записью — они в окне входа.
                    </Plate>
                )}
                <ButtonDesktop view='primary' size={56} block={true} type='submit'>
                    Зарегистрироваться
                </ButtonDesktop>
            </form>
            <AuthSwitch text='Уже есть профиль?' action='Войти' onClick={onLogin} />
        </AuthModal>
    );
}
