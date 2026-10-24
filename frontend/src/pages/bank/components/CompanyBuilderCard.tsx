import { Button } from '@alfalab/core-components/button';
import { Input } from '@alfalab/core-components/input';
import { Plate } from '@alfalab/core-components/plate';
import { Select } from '@alfalab/core-components/select';
import { Switch } from '@alfalab/core-components/switch';
import { Typography } from '@alfalab/core-components/typography';
import { type FormEvent, type ReactNode, useState } from 'react';

import { useCompanyOptions, useCreateCompany } from '../../../api/hooks';
import type { CompanyBuilderInput, CompanyBuilderResult } from '../../../api/types';
import { ErrorPlate } from '../../../components/ui';
import { Card } from './common';
import './CompanyBuilderCard.css';

/** Устойчивая компания: 6 лет работы, растущая прибыльная выручка, без кредитов и долгов, клиент банка 3 года. */
const DEFAULTS: CompanyBuilderInput = {
    name: 'Белые ночи',
    legal_form: 'OOO',
    registered_months_ago: 72,
    okved: '46.39',
    revenue: 60_000_000,
    revenue_growth: 0.12,
    margin: 0.1,
    existing_monthly_payments: 0,
    max_overdue_days_24m: 0,
    current_overdue_days: 0,
    tax_debt: 0,
    mass_address: false,
    director_disqualified: false,
    company_status: 'ACTIVE',
    is_bank_client: true,
    account_months: 36,
    avg_monthly_inflow: 5_000_000,
};

const LEGAL_FORMS = [
    { key: 'OOO', content: 'ООО' },
    { key: 'IP', content: 'ИП' },
];

const STATUSES = [
    { key: 'ACTIVE', content: 'Действующая' },
    { key: 'LIQUIDATING', content: 'В процессе ликвидации' },
];

const RISK_LABELS: Record<string, string> = { LOW: 'низкий', MEDIUM: 'средний', HIGH: 'высокий' };

const numberFormat = new Intl.NumberFormat('ru-RU');
const digits = (value: string): number => Number(value.replace(/\D/g, '')) || 0;
const formatDigits = (value: number): string => numberFormat.format(value);
/** Проценты в поле: 0,12 → «12»; при вводе принимаются запятая и точка. */
const percentText = (fraction: number): string => String(Math.round(fraction * 1000) / 10).replace('.', ',');
function parsePercent(text: string): number | null {
    const value = Number(text.replace(',', '.').replace(/\s/g, ''));
    return text.trim() && Number.isFinite(value) ? value / 100 : null;
}

const Rub = () => (
    <Typography.Text view='primary-medium' color='secondary'>
        ₽
    </Typography.Text>
);

const Unit = ({ children }: { children: ReactNode }) => (
    <Typography.Text view='primary-medium' color='secondary'>
        {children}
    </Typography.Text>
);

function MoneyInput({
    label,
    value,
    hint,
    onChange,
}: {
    label: string;
    value: number;
    hint?: string;
    onChange: (value: number) => void;
}) {
    return (
        <Input
            label={label}
            labelView='inner'
            size={56}
            block={true}
            value={formatDigits(value)}
            onChange={(e) => onChange(digits(e.target.value))}
            rightAddons={<Rub />}
            hint={hint}
            inputMode='numeric'
        />
    );
}

function CountInput({
    label,
    value,
    unit,
    hint,
    onChange,
}: {
    label: string;
    value: number;
    unit: string;
    hint?: string;
    onChange: (value: number) => void;
}) {
    return (
        <Input
            label={label}
            labelView='inner'
            size={56}
            block={true}
            value={String(value)}
            onChange={(e) => onChange(digits(e.target.value))}
            rightAddons={<Unit>{unit}</Unit>}
            hint={hint}
            inputMode='numeric'
        />
    );
}

function Result({ data }: { data: CompanyBuilderResult }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard
            ?.writeText(data.login)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
    };
    return (
        <Plate view='positive' rounded={true} limitContentWidth={false} title={`Компания ${data.company.name} создана`}>
            <div className='company-builder__result'>
                <div>
                    Логин: <span className='company-builder__login'>{data.login}</span>, пароль:{' '}
                    <span className='company-builder__login'>{data.password}</span>. ИНН {data.inn}, руководитель —{' '}
                    {data.company.director_name}.
                </div>
                <div className='row'>
                    <Button view='secondary' size={32} onClick={copy}>
                        {copied ? 'Логин скопирован' : 'Скопировать логин'}
                    </Button>
                    <span className='bank-sub'>Выйдите и войдите под этим логином, чтобы подать заявку.</span>
                </div>
            </div>
        </Plate>
    );
}

/**
 * Своя тестовая компания: форма с параметрами → компания во всех внешних системах симулятора,
 * в базе — компания и пользователь-руководитель с правом подписи. Исход заявки считает конвейер.
 */
export function CompanyBuilderCard() {
    const options = useCompanyOptions();
    const create = useCreateCompany();
    const [form, setForm] = useState<CompanyBuilderInput>(DEFAULTS);
    const [growth, setGrowth] = useState(percentText(DEFAULTS.revenue_growth));
    const [margin, setMargin] = useState(percentText(DEFAULTS.margin));
    const [tried, setTried] = useState(false);

    const set = (patch: Partial<CompanyBuilderInput>) => setForm((current) => ({ ...current, ...patch }));
    const growthValue = parsePercent(growth);
    const marginValue = parsePercent(margin);
    const nameMissing = !form.name.trim();
    const okved = options.data?.okved.find((item) => item.code === form.okved);
    const isIp = form.legal_form === 'IP';

    const submit = (event: FormEvent) => {
        event.preventDefault();
        setTried(true);
        if (nameMissing || growthValue === null || marginValue === null) return;
        create.mutate({ ...form, name: form.name.trim(), revenue_growth: growthValue, margin: marginValue });
    };

    return (
        <Card title='Своя тестовая компания'>
            <form className='company-builder' onSubmit={submit}>
                <div className='company-builder__intro'>
                    Для проверки своих сценариев. Компания появится во всех внешних системах симулятора — ЕГРЮЛ, ФНС,
                    ГИР БО, БКИ и банке, а в кабинете — учётная запись её руководителя с правом подписи. Исход заявки
                    заранее не задаётся: его считает конвейер по общим правилам скоринга и кредитной политики.
                </div>
                <div className='company-builder__grid'>
                    <div className='company-builder__section'>
                        <div className='bank-caption'>Компания</div>
                        <Input
                            label={isIp ? 'Фамилия, имя и отчество предпринимателя' : 'Название без формы'}
                            labelView='inner'
                            size={56}
                            block={true}
                            value={form.name}
                            onChange={(e) => set({ name: e.target.value })}
                            error={tried && nameMissing ? 'Укажите название компании' : undefined}
                            hint={
                                isIp
                                    ? 'В реестре появится «ИП Фамилия Имя Отчество», логин — из фамилии'
                                    : 'В реестре появится «ООО «Название»», логин — латиницей из названия'
                            }
                        />
                        <div className='company-builder__pair'>
                            <Select
                                label='Форма'
                                labelView='inner'
                                size={56}
                                block={true}
                                options={LEGAL_FORMS}
                                selected={form.legal_form}
                                onChange={({ selected }) =>
                                    set({ legal_form: (selected?.key as CompanyBuilderInput['legal_form']) ?? 'OOO' })
                                }
                                hint={isIp ? 'ИП не сдаёт отчётность в ГИР БО' : 'У ООО есть отчётность за два года'}
                            />
                            <CountInput
                                label='Зарегистрирована'
                                value={form.registered_months_ago}
                                unit='мес. назад'
                                hint='Меньше 3 — стоп-фактор, меньше 12 — только кредит для начинающих'
                                onChange={(value) => set({ registered_months_ago: value })}
                            />
                        </div>
                        <Select
                            label='Основной ОКВЭД'
                            labelView='inner'
                            size={56}
                            block={true}
                            options={(options.data?.okved ?? []).map((item) => ({
                                key: item.code,
                                content: `${item.code} — ${item.name}`,
                            }))}
                            selected={form.okved}
                            onChange={({ selected }) => set({ okved: selected?.key ?? DEFAULTS.okved })}
                            hint={
                                okved
                                    ? `Отраслевой риск ${RISK_LABELS[okved.industry_risk]}, типичная рентабельность ` +
                                      `${percentText(okved.typical_margin)} %`
                                    : 'По коду считаются отраслевой риск и типичная рентабельность'
                            }
                        />
                        <Select
                            label='Статус в реестре'
                            labelView='inner'
                            size={56}
                            block={true}
                            options={STATUSES}
                            selected={form.company_status}
                            onChange={({ selected }) =>
                                set({
                                    company_status:
                                        (selected?.key as CompanyBuilderInput['company_status']) ?? 'ACTIVE',
                                })
                            }
                            hint='Ликвидация — стоп-фактор S01, отказ'
                        />
                        <div className='company-builder__switches'>
                            <Switch
                                checked={form.mass_address}
                                onChange={(_, { checked }) => set({ mass_address: checked })}
                                label='Адрес массовой регистрации'
                                hint='Флаг F01 — заявку рассмотрит аналитик'
                                block={true}
                            />
                            <Switch
                                checked={form.director_disqualified}
                                onChange={(_, { checked }) => set({ director_disqualified: checked })}
                                label='Руководитель дисквалифицирован'
                                hint='Стоп-фактор S02, отказ'
                                block={true}
                            />
                        </div>
                        <div className='bank-caption'>Счёт в банке</div>
                        <Switch
                            checked={form.is_bank_client}
                            onChange={(_, { checked }) => set({ is_bank_client: checked })}
                            label='Клиент банка'
                            hint='Без счёта выручку оценят по отчётности, а ИП попросят выписку'
                            block={true}
                        />
                        {form.is_bank_client && (
                            <div className='company-builder__pair'>
                                <CountInput
                                    label='Счёт открыт'
                                    value={form.account_months}
                                    unit='мес. назад'
                                    hint='Овердрафт — от 6 месяцев; поступления 12 месяцев дают больше баллов'
                                    onChange={(value) => set({ account_months: value })}
                                />
                                <MoneyInput
                                    label='Поступления в месяц'
                                    value={form.avg_monthly_inflow}
                                    hint='Среднее за месяц, по месяцам будет небольшой разброс'
                                    onChange={(value) => set({ avg_monthly_inflow: value })}
                                />
                            </div>
                        )}
                    </div>

                    <div className='company-builder__section'>
                        <div className='bank-caption'>Финансы и кредитная история</div>
                        <MoneyInput
                            label='Выручка за последний год'
                            value={form.revenue}
                            hint='Лимит без залога — до 50 % выручки; сумма больше половины выручки снижает балл'
                            onChange={(value) => set({ revenue: value })}
                        />
                        <div className='company-builder__pair'>
                            <Input
                                label='Рост выручки за год'
                                labelView='inner'
                                size={56}
                                block={true}
                                value={growth}
                                onChange={(e) => setGrowth(e.target.value)}
                                rightAddons={<Unit>%</Unit>}
                                error={tried && growthValue === null ? 'Укажите число' : undefined}
                                hint='Отрицательное — снижение; падение больше 10 % снимает баллы'
                                inputMode='decimal'
                            />
                            <Input
                                label='Рентабельность продаж'
                                labelView='inner'
                                size={56}
                                block={true}
                                value={margin}
                                onChange={(e) => setMargin(e.target.value)}
                                rightAddons={<Unit>%</Unit>}
                                error={tried && marginValue === null ? 'Укажите число' : undefined}
                                hint='Прибыль от продаж к выручке; от неё зависит DSCR и лимит'
                                inputMode='decimal'
                            />
                        </div>
                        <MoneyInput
                            label='Платежи по текущим кредитам в месяц'
                            value={form.existing_monthly_payments}
                            hint='0 — действующих кредитов нет'
                            onChange={(value) => set({ existing_monthly_payments: value })}
                        />
                        <div className='company-builder__pair'>
                            <CountInput
                                label='Макс. просрочка за 24 мес.'
                                value={form.max_overdue_days_24m}
                                unit='дн.'
                                hint='От 1 дня снимает баллы, от 30 — заметно'
                                onChange={(value) => set({ max_overdue_days_24m: value })}
                            />
                            <CountInput
                                label='Текущая просрочка'
                                value={form.current_overdue_days}
                                unit='дн.'
                                hint='1–30 дней — флаг F06, больше 30 — стоп-фактор S03'
                                onChange={(value) => set({ current_overdue_days: value })}
                            />
                        </div>
                        <MoneyInput
                            label='Налоговая задолженность'
                            value={form.tax_debt}
                            hint='Любая сумма — флаг F02 и ручное рассмотрение'
                            onChange={(value) => set({ tax_debt: value })}
                        />
                    </div>
                </div>
                <div className='company-builder__footer'>
                    <Button view='primary' size={48} type='submit' loading={create.isPending}>
                        Создать компанию
                    </Button>
                    <span className='bank-sub'>
                        Пароль у всех демо-пользователей — admin. Сброс демо-данных компанию не удалит.
                    </span>
                </div>
                <ErrorPlate error={options.error} title='Не удалось загрузить справочник ОКВЭД' />
                <ErrorPlate error={create.error} title='Компания не создана' />
                {create.data && <Result key={create.data.login} data={create.data} />}
            </form>
        </Card>
    );
}
