import { ButtonDesktop } from '@alfalab/core-components/button/desktop';
import { Input } from '@alfalab/core-components/input';
import { ModalDesktop } from '@alfalab/core-components/modal/desktop';
import { PasswordInput } from '@alfalab/core-components/password-input';
import { Typography } from '@alfalab/core-components/typography';
import { type FormEvent, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { AppFooter } from '../components/AppFooter';
import { Logo } from '../components/AppHeader';
import { ErrorPlate } from '../components/ui';
import { HOW_IT_WORKS } from './client/DashboardPage';
import { HeroArt, ProductsBanner, PromoBanners } from './landing/Banners';
import { Faq } from './landing/Faq';

const CLIENTS = [
    { login: 'veter', company: 'ООО «Северный ветер»', hint: 'Автоодобрение и выдача' },
    { login: 'smirnova', company: 'ИП Смирнова', hint: 'Овердрафт: контрпредложение' },
    { login: 'tehnomaster', company: 'ООО «ТехноМастер»', hint: 'Два варианта условий' },
    { login: 'orlov', company: 'ИП Орлов', hint: 'Банк запросит выписку' },
    { login: 'vektor', company: 'ООО «Вектор Логистик»', hint: 'Ручное рассмотрение' },
    { login: 'grand', company: 'ООО «Гранд Девелопмент»', hint: 'Кредит под залог' },
    { login: 'start', company: 'ООО «Новый старт»', hint: 'Бизнесу 5 месяцев' },
    { login: 'altair', company: 'ООО «Альтаир»', hint: 'Для демонстрации сбоев' },
    { login: 'romashka', company: 'ООО «Ромашка-Строй»', hint: 'Отказ: ликвидация' },
    { login: 'meridian', company: 'ООО «Меридиан»', hint: 'Отказ: просрочка' },
];

const STAFF = [
    { login: 'analyst', company: 'Кредитный аналитик', hint: 'Иванова Ольга' },
    { login: 'analyst2', company: 'Кредитный аналитик', hint: 'Ковалёв Павел' },
    { login: 'admin', company: 'Администратор', hint: 'Сброс демо и сбои' },
];

// Длительность выезда окна и размытия фона — совпадает с переходами .login-modal и .login-backdrop в global.css
const TRANSITION_MS = 320;

/**
 * Стартовая страница: шапка с кнопкой «Войти», как на alfabank.ru, баннеры о кредитах и ответы на вопросы.
 * Вход — в окне поверх размытой страницы. Кнопки баннеров открывают то же окно, а клиент после входа
 * попадает сразу в подбор кредита.
 */
export function LoginPage() {
    const { user } = useAuth();
    const [open, setOpen] = useState(false);
    const [next, setNext] = useState<string | null>(null);

    if (user) return <Navigate to={user.role === 'CLIENT' ? '/client' : '/bank'} replace={true} />;

    const enter = (path: string | null) => {
        setNext(path);
        setOpen(true);
    };
    const start = () => enter('/client/new');

    return (
        <div className='app login'>
            <header className='header'>
                <div className='header__inner'>
                    <Logo home='/login' />
                    <div className='header__right'>
                        {/*
                         * Страницу видят только гости — после входа она ведёт в кабинет, где «Получить кредит» есть
                         * в шапке. Поэтому здесь кнопка открывает вход, а клиент после входа сразу попадает в подбор.
                         * Настольный вариант кнопок на любой ширине: мобильные чёрные и пропали бы на шапке.
                         */}
                        <ButtonDesktop view='secondary' colors='inverted' size={40} onClick={start}>
                            Получить кредит
                        </ButtonDesktop>
                        <ButtonDesktop view='primary' size={40} onClick={() => enter(null)}>
                            Войти
                        </ButtonDesktop>
                    </div>
                </div>
            </header>

            <section className='login__brand'>
                <div className='login__inner landing-hero'>
                    <div className='stack-16 landing-hero__text'>
                        <Typography.TitleResponsive
                            tag='h1'
                            view='xlarge'
                            font='system'
                            weight='bold'
                            color='primary-inverted'
                        >
                            {/* неразрывные пробелы: строка не начинается с тире и не кончается на «от» */}
                            {'Кредит для бизнеса — от задачи до денег на счёте'}
                        </Typography.TitleResponsive>
                        <Typography.Text view='primary-large' color='secondary-inverted' tag='p'>
                            Подберём продукт под вашу задачу, данные компании подтянем из ЕГРЮЛ, статус заявки — в
                            реальном времени. Подписание и выдача — прямо в кабинете.
                        </Typography.Text>
                        <div className='landing-hero__actions'>
                            <ButtonDesktop view='primary' size={56} onClick={start}>
                                Подобрать кредит
                            </ButtonDesktop>
                        </div>
                        <Typography.Text
                            view='primary-small'
                            color='secondary-inverted'
                            tag='p'
                            className='login__note'
                        >
                            Демонстрационный стенд: все компании и данные синтетические.
                        </Typography.Text>
                    </div>
                    <HeroArt />
                </div>
            </section>

            <section className='login__sheet'>
                <div className='login__inner landing-sections'>
                    <ProductsBanner onStart={start} />
                    <PromoBanners onStart={start} />

                    <section className='stack'>
                        <Typography.Title tag='h2' view='medium' font='system' weight='bold'>
                            Как получить кредит
                        </Typography.Title>
                        <ol className='login__steps'>
                            {HOW_IT_WORKS.map((step, index) => (
                                <li key={step.title} className='login__step'>
                                    <span className='login__step-number'>{index + 1}</span>
                                    <Typography.Text view='primary-medium' weight='bold' tag='div'>
                                        {step.title}
                                    </Typography.Text>
                                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                                        {step.text}
                                    </Typography.Text>
                                </li>
                            ))}
                        </ol>
                    </section>

                    <Faq />
                </div>
            </section>

            <AppFooter />
            <LoginWidget open={open} next={next} onClose={() => setOpen(false)} />
        </div>
    );
}

/**
 * Окно входа по центру экрана: логин и пароль своей учётной записи и быстрый вход в тестовые.
 * Состояние формы живёт снаружи окна — после закрытия и повторного открытия введённое не теряется.
 * next — куда вести клиента после входа (с баннера — в подбор кредита); сотрудник банка всегда попадает в очередь.
 */
function LoginWidget({ open, next, onClose }: { open: boolean; next: string | null; onClose: () => void }) {
    const { login } = useAuth();
    const navigate = useNavigate();
    const loginInput = useRef<HTMLInputElement>(null);
    const [loginName, setLoginName] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (event?: FormEvent, name = loginName, pass = password) => {
        event?.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const result = await login(name, pass);
            navigate(result.role === 'CLIENT' ? (next ?? '/client') : '/bank');
        } catch (e) {
            setError(e);
        } finally {
            setBusy(false);
        }
    };

    const quick = (name: string) => {
        setLoginName(name);
        setPassword('admin');
        void submit(undefined, name, 'admin');
    };

    return (
        <ModalDesktop
            open={open}
            onClose={onClose}
            className='login-modal'
            wrapperClassName='login-modal__wrapper'
            contentClassName='login-modal__content'
            scrollHandler='content'
            wrapperProps={{ 'aria-label': 'Вход' }}
            transitionProps={{
                classNames: 'login-modal',
                timeout: TRANSITION_MS,
                onEntered: () => loginInput.current?.focus(),
            }}
            backdropProps={{
                className: 'login-backdrop',
                transitionClassNames: 'login-backdrop',
                timeout: TRANSITION_MS,
            }}
        >
            <ModalDesktop.Header hasCloser={true} sticky={true} title='Вход' />
            <ModalDesktop.Content>
                <div className='stack login-modal__body'>
                    <form className='stack-16' onSubmit={submit}>
                        <Input
                            ref={loginInput}
                            label='Логин'
                            labelView='inner'
                            size={56}
                            block={true}
                            value={loginName}
                            onChange={(e) => setLoginName(e.target.value)}
                            autoComplete='username'
                            name='login'
                        />
                        <PasswordInput
                            label='Пароль'
                            labelView='inner'
                            size={56}
                            block={true}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete='current-password'
                            name='password'
                        />
                        <ErrorPlate error={error} title='Не удалось войти' />
                        {/* та же красная кнопка, что в шапке, на любой ширине */}
                        <ButtonDesktop view='primary' size={56} block={true} type='submit' loading={busy}>
                            Войти
                        </ButtonDesktop>
                    </form>

                    <div className='stack-8'>
                        <Typography.Text view='primary-medium' weight='bold' tag='div'>
                            Тестовые учётные записи
                        </Typography.Text>
                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                            Пароль у всех — admin. Нажмите, чтобы войти.
                        </Typography.Text>
                        <AccountGroup title='Клиенты' accounts={CLIENTS} onPick={quick} />
                        <AccountGroup title='Сотрудники банка' accounts={STAFF} onPick={quick} />
                    </div>
                </div>
            </ModalDesktop.Content>
        </ModalDesktop>
    );
}

function AccountGroup({
    title,
    accounts,
    onPick,
}: {
    title: string;
    accounts: { login: string; company: string; hint: string }[];
    onPick: (login: string) => void;
}) {
    return (
        <>
            <Typography.Text view='caps' color='secondary' tag='div' style={{ marginTop: 8 }}>
                {title}
            </Typography.Text>
            <div className='demo-accounts'>
                {accounts.map((account) => (
                    <button
                        key={account.login}
                        type='button'
                        className='demo-account'
                        onClick={() => onPick(account.login)}
                    >
                        <Typography.Text view='primary-small' weight='medium' tag='div'>
                            {account.company}
                        </Typography.Text>
                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                            {account.login} · {account.hint}
                        </Typography.Text>
                    </button>
                ))}
            </div>
        </>
    );
}
