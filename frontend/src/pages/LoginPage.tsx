import { ButtonDesktop } from '@alfalab/core-components/button/desktop';
import { Input } from '@alfalab/core-components/input';
import { PasswordInput } from '@alfalab/core-components/password-input';
import { Typography } from '@alfalab/core-components/typography';
import { type FormEvent, useRef, useState } from 'react';
import { Navigate, NavLink, useNavigate } from 'react-router-dom';

import { useProducts } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { AppFooter } from '../components/AppFooter';
import { Logo } from '../components/AppHeader';
import { ErrorPlate } from '../components/ui';
import { HOW_IT_WORKS } from './client/DashboardPage';
import { AuthModal, AuthSwitch } from './landing/AuthModal';
import { AudienceSection, HeroArt, ProductsBanner, PromoBanners } from './landing/Banners';
import { Faq } from './landing/Faq';
import { ProductsPage } from './landing/ProductsPage';
import { RegisterWidget } from './landing/RegisterWidget';
import { num, percent } from '../utils/format';

/** Клиенты по персонам (docs/product.md#персоны): сегменты, которые банк обрабатывает по-разному. */
const CLIENT_GROUPS = [
    {
        title: 'ИП на упрощёнке',
        accounts: [
            { login: 'smirnova', company: 'ИП Смирнова', hint: 'Овердрафт: контрпредложение' },
            { login: 'orlov', company: 'ИП Орлов', hint: 'Банк запросит выписку' },
        ],
    },
    {
        title: 'ООО с финансовой службой',
        accounts: [
            { login: 'veter', company: 'ООО «Северный ветер»', hint: 'Автоодобрение и выдача' },
            { login: 'tehnomaster', company: 'ООО «ТехноМастер»', hint: 'Два варианта условий' },
            { login: 'vektor', company: 'ООО «Вектор Логистик»', hint: 'Ручное рассмотрение' },
        ],
    },
    {
        title: 'Молодой бизнес',
        accounts: [{ login: 'start', company: 'ООО «Новый старт»', hint: 'Бизнесу 5 месяцев' }],
    },
    {
        title: 'Особые случаи',
        accounts: [
            { login: 'grand', company: 'ООО «Гранд Девелопмент»', hint: 'Кредит под залог' },
            { login: 'altair', company: 'ООО «Альтаир»', hint: 'Для демонстрации сбоев' },
            { login: 'romashka', company: 'ООО «Ромашка-Строй»', hint: 'Отказ: ликвидация' },
            { login: 'meridian', company: 'ООО «Меридиан»', hint: 'Отказ: просрочка' },
        ],
    },
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
export function LoginPage({
    guestOnly = false,
    page = 'landing',
}: {
    guestOnly?: boolean;
    /** products — страница «Продукты» в той же оболочке: шапка, окно входа, подвал */
    page?: 'landing' | 'products';
}) {
    const { user, loading } = useAuth();
    const navigate = useNavigate();
    const [dialog, setDialog] = useState<'login' | 'register' | null>(null);
    const { data: products } = useProducts();
    const minRate = products?.length ? Math.min(...products.map((product) => num(product.base_rate))) : null;
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
                    {/* меню — только вошедшему клиенту, как в шапке кабинета; гостю — логотип и вход */}
                    {user?.role === 'CLIENT' && (
                        <nav className='nav' aria-label='Разделы'>
                            {/* те же пункты, что в шапке кабинета: «Главная» ведёт в кабинет */}
                            <NavLink
                                to={cabinet}
                                end={true}
                                className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
                            >
                                Главная
                            </NavLink>
                            <NavLink
                                to='/products'
                                className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
                            >
                                Продукты
                            </NavLink>
                            <button type='button' className='nav__link login__nav-button' onClick={start}>
                                Получить кредит
                            </button>
                        </nav>
                    )}
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

            {page === 'products' ? (
                <ProductsPage />
            ) : (
                <>
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
                                    {/* как на alfabank.ru; ставка — минимальная базовая по каталогу, а не обещание */}
                                    Кредиты для бизнеса
                                    {minRate !== null && (
                                        <>
                                            <br />
                                            от {percent(minRate)}
                                        </>
                                    )}
                                </Typography.TitleResponsive>
                                <Typography.Text view='primary-large' color='primary-inverted' tag='p'>
                                    Получите деньги на развитие своего дела
                                </Typography.Text>
                                <div className='landing-hero__actions'>
                                    <ButtonDesktop view='primary' size={56} onClick={start}>
                                        Оформить заявку
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
                </>
            )}

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
        <AuthModal open={open} title='Вход' wide={true} onClose={onClose} onEntered={() => loginInput.current?.focus()}>
            {/* форма по центру сверху, под ней тестовые учётные записи — всё видно сразу, без прокрутки */}
            <div className='stack'>
                <div className='stack-16 login-modal__form'>
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
                        {/* та же красная кнопка, что в шапке, на любой ширине — по размеру надписи */}
                        <div className='login-modal__submit'>
                            <ButtonDesktop view='primary' size={48} type='submit' loading={busy}>
                                Войти
                            </ButtonDesktop>
                        </div>
                    </form>
                    <AuthSwitch text='Нет профиля?' action='Создать' onClick={onRegister} />
                </div>

                <div className='stack-8 login-modal__accounts'>
                    <Typography.Text view='primary-medium' weight='bold' tag='div'>
                        Тестовые учётные записи
                    </Typography.Text>
                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                        Пароль у всех — admin. Нажмите, чтобы войти.
                    </Typography.Text>
                    {CLIENT_GROUPS.map((group) => (
                        <AccountGroup key={group.title} title={group.title} accounts={group.accounts} onPick={quick} />
                    ))}
                    <AccountGroup title='Сотрудники банка' accounts={STAFF} onPick={quick} />
                </div>
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
