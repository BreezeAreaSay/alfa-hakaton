import { ButtonDesktop } from '@alfalab/core-components/button/desktop';
import { Input } from '@alfalab/core-components/input';
import { PasswordInput } from '@alfalab/core-components/password-input';
import { Typography } from '@alfalab/core-components/typography';
import { type FormEvent, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { AppFooter } from '../components/AppFooter';
import { Logo } from '../components/AppHeader';
import { ErrorPlate } from '../components/ui';
import { HOW_IT_WORKS } from './client/DashboardPage';
import { AuthModal, AuthSwitch } from './landing/AuthModal';
import { AudienceSection, HeroArt, ProductsBanner, PromoBanners } from './landing/Banners';
import { Faq } from './landing/Faq';
import { RegisterWidget } from './landing/RegisterWidget';

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

/**
 * Стартовая страница: шапка как на alfabank.ru, баннеры о кредитах и ответы на вопросы. Открыта и гостю,
 * и после входа — в неё возвращает логотип в шапке кабинета. Гостю «Получить кредит» и кнопки баннеров
 * открывают окно входа, и после входа клиент попадает сразу в подбор кредита; вошедшему — сразу подбор.
 * Гостю рядом с «Войти» — «Регистрация» (пока только интерфейс). guestOnly — для адреса /login: вошедшего
 * он ведёт в кабинет.
 */
export function LoginPage({ guestOnly = false }: { guestOnly?: boolean }) {
    const { user, loading } = useAuth();
    const navigate = useNavigate();
    const [dialog, setDialog] = useState<'login' | 'register' | null>(null);
    const [next, setNext] = useState<string | null>(null);

    const cabinet = user?.role === 'CLIENT' ? '/client' : '/bank';
    if (guestOnly && user) return <Navigate to={cabinet} replace={true} />;

    const enter = (path: string | null) => {
        setNext(path);
        setDialog('login');
    };
    // Сотрудника банка кабинет клиента сам отправит на рабочее место
    const start = () => (user ? navigate('/client/new') : enter('/client/new'));

    return (
        <div className='app login'>
            <header className='header'>
                <div className='header__inner'>
                    <Logo home='/' />
                    {/* слева, как пункт меню в шапке кабинета */}
                    <nav className='nav' aria-label='Разделы'>
                        <button type='button' className='nav__link login__nav-button' onClick={start}>
                            Получить кредит
                        </button>
                    </nav>
                    <div className='header__right'>
                        {/*
                         * Пока проверяется сохранённый вход, кнопки нет — чтобы «Войти» не мелькнуло у вошедшего.
                         * Настольный вариант на любой ширине: мобильная главная кнопка чёрная и пропала бы на шапке.
                         */}
                        {!loading &&
                            (user ? (
                                <ButtonDesktop view='primary' size={40} onClick={() => navigate(cabinet)}>
                                    {user.role === 'CLIENT' ? 'Личный кабинет' : 'Рабочее место'}
                                </ButtonDesktop>
                            ) : (
                                <>
                                    {/* на телефоне в шапке не помещается — регистрация открывается из окна входа */}
                                    <ButtonDesktop
                                        view='primary'
                                        size={40}
                                        className='login__register'
                                        onClick={() => setDialog('register')}
                                    >
                                        Регистрация
                                    </ButtonDesktop>
                                    <ButtonDesktop view='primary' size={40} onClick={() => enter(null)}>
                                        Войти
                                    </ButtonDesktop>
                                </>
                            ))}
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
                    <AudienceSection />
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
            <LoginWidget
                open={dialog === 'login'}
                next={next}
                onClose={() => setDialog(null)}
                onRegister={() => setDialog('register')}
            />
            <RegisterWidget open={dialog === 'register'} onClose={() => setDialog(null)} onLogin={() => enter(null)} />
        </div>
    );
}

/**
 * Окно входа по центру экрана: логин и пароль своей учётной записи и быстрый вход в тестовые.
 * Состояние формы живёт снаружи окна — после закрытия и повторного открытия введённое не теряется.
 * next — куда вести клиента после входа (с баннера — в подбор кредита); сотрудник банка всегда попадает в очередь.
 */
function LoginWidget({
    open,
    next,
    onClose,
    onRegister,
}: {
    open: boolean;
    next: string | null;
    onClose: () => void;
    onRegister: () => void;
}) {
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
        <AuthModal open={open} title='Вход' onClose={onClose} onEntered={() => loginInput.current?.focus()}>
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
            <AuthSwitch text='Нет профиля?' action='Создать' onClick={onRegister} />

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
        </AuthModal>
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
