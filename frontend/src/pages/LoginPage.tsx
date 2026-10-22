import { Button } from '@alfalab/core-components/button';
import { Input } from '@alfalab/core-components/input';
import { PasswordInput } from '@alfalab/core-components/password-input';
import { Typography } from '@alfalab/core-components/typography';
import { AlfaBankLIcon } from '@alfalab/icons-logotype/AlfaBankLIcon';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { ErrorPlate } from '../components/ui';

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

export function LoginPage() {
    const { user, login } = useAuth();
    const navigate = useNavigate();
    const [loginName, setLoginName] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    if (user) return <Navigate to={user.role === 'CLIENT' ? '/client' : '/bank'} replace={true} />;

    const submit = async (event?: FormEvent, name = loginName, pass = password) => {
        event?.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const result = await login(name, pass);
            navigate(result.role === 'CLIENT' ? '/client' : '/bank');
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
        <div className='login'>
            <section className='login__brand'>
                <div className='login__inner'>
                    <div className='logo'>
                        <span className='logo__mark'>
                            <AlfaBankLIcon width={21} height={32} aria-label='Альфа-Банк' />
                        </span>
                        <Typography.Text view='primary-medium' weight='bold' color='primary-inverted'>
                            Кредитный кабинет для бизнеса
                        </Typography.Text>
                    </div>
                    <div className='stack-16'>
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
                        <Typography.Text
                            view='primary-large'
                            color='secondary-inverted'
                            tag='p'
                            className='login__lead'
                        >
                            Подберём продукт под вашу задачу, данные компании подтянем из ЕГРЮЛ, статус заявки — в
                            реальном времени. Подписание и выдача — прямо в кабинете.
                        </Typography.Text>
                    </div>
                    <Typography.Text view='primary-small' color='secondary-inverted' tag='p' className='login__note'>
                        Демонстрационный стенд: все компании и данные синтетические.
                    </Typography.Text>
                </div>
            </section>

            <section className='login__form'>
                <div className='login__inner stack'>
                    <Typography.Title tag='h2' view='medium' font='system' weight='bold'>
                        Вход
                    </Typography.Title>
                    <form className='stack-16' onSubmit={submit}>
                        <Input
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
                        <Button view='primary' size={56} block={true} type='submit' loading={busy}>
                            Войти
                        </Button>
                    </form>

                    <div className='stack-8'>
                        <Typography.Text view='primary-medium' weight='bold' tag='div'>
                            Тестовые учётные записи
                        </Typography.Text>
                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                            Пароль у всех — admin. Нажмите, чтобы войти.
                        </Typography.Text>
                        <Typography.Text view='caps' color='secondary' tag='div' style={{ marginTop: 8 }}>
                            Клиенты
                        </Typography.Text>
                        <div className='demo-accounts'>
                            {CLIENTS.map((account) => (
                                <button
                                    key={account.login}
                                    type='button'
                                    className='demo-account'
                                    onClick={() => quick(account.login)}
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
                        <Typography.Text view='caps' color='secondary' tag='div' style={{ marginTop: 8 }}>
                            Сотрудники банка
                        </Typography.Text>
                        <div className='demo-accounts'>
                            {STAFF.map((account) => (
                                <button
                                    key={account.login}
                                    type='button'
                                    className='demo-account'
                                    onClick={() => quick(account.login)}
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
                    </div>
                </div>
            </section>
        </div>
    );
}
