import { Plate } from '@alfalab/core-components/plate';
import type { ReactNode } from 'react';

import type { Dossier, Meta, SourceResult } from '../../../api/types';
import { Badge, KeyValue, Metric, StepList } from '../../../components/ui';
import { date, dateTime, legalFormLabel, months, percent, rub } from '../../../utils/format';
import { Card, Check, SOURCE_STATE, Sub } from './common';
import { InflowChart } from './InflowChart';

export interface EgrulResult {
    found?: boolean;
    name: string;
    legal_form: 'OOO' | 'IP' | null;
    ogrn: string | null;
    registration_date: string | null;
    status: string | null;
    okved: string | null;
    okved_name: string | null;
    address: string | null;
    director?: { name: string; since: string | null } | null;
}

interface FnsResult {
    tax_debt: number;
    mass_address: boolean;
    director_disqualified: boolean;
    employees?: number | null;
    tax_regime?: string | null;
}

interface GirboYear {
    year: number;
    revenue: number;
    sales_profit: number;
    net_profit: number;
}

interface GirboResult {
    available: boolean;
    reason?: string;
    years?: GirboYear[];
}

interface BkiLoan {
    lender: string;
    kind: string;
    amount: number;
    balance: number;
    monthly_payment: number;
    opened_at: string | null;
}

interface BkiResult {
    has_history: boolean;
    max_overdue_days_24m: number;
    current_overdue_days: number;
    loans?: BkiLoan[];
}

interface BankResult {
    is_client: boolean;
    account_opened_at: string | null;
    months?: { month: string; inflow: number }[];
}

interface DataCheckResult {
    checks?: { title: string; ok: boolean }[];
}

export function sourceResult<T>(source: SourceResult | undefined): T | null {
    return (source?.result as T | null | undefined) ?? null;
}

function SourceCard({
    title,
    source,
    children,
}: {
    title: string;
    source: SourceResult | undefined;
    children?: ReactNode;
}) {
    const state = SOURCE_STATE[source?.status ?? 'PENDING'];
    const broken = source && (source.status === 'WAITING' || source.status === 'FAILED');
    return (
        <Card title={title} extra={<Badge color={state.color}>{state.label}</Badge>}>
            {broken && (
                <div className='bank-gap-bottom'>
                    <Plate
                        view={source.status === 'FAILED' ? 'negative' : 'attention'}
                        rounded={true}
                        limitContentWidth={false}
                        title={
                            source.status === 'FAILED'
                                ? 'Источник не ответил после всех повторов'
                                : 'Ждём ответ источника'
                        }
                    >
                        {source.error ?? 'Нет ответа'} · попыток: {source.attempts}
                    </Plate>
                </div>
            )}
            {source?.result ? children : !broken && <Sub>{source ? 'Данных нет' : 'Запрос ещё не выполнялся'}</Sub>}
            {source?.finished_at && (
                <div className='bank-sub bank-gap-top'>
                    Ответ получен {dateTime(source.finished_at)}
                    {source.attempts > 1 ? ` · попыток: ${source.attempts}` : ''}
                </div>
            )}
        </Card>
    );
}

function EgrulFacts({ result, meta }: { result: EgrulResult; meta: Meta | undefined }) {
    if (result.found === false) return <Sub>Компания не найдена в реестре</Sub>;
    const status = result.status ? (meta?.company_statuses[result.status] ?? result.status) : null;
    return (
        <KeyValue
            items={[
                ['Наименование', result.name],
                ['Форма', legalFormLabel(result.legal_form)],
                ['ОГРН', result.ogrn ?? '—'],
                ['Дата регистрации', date(result.registration_date)],
                ['Статус', status ? <Badge color={result.status === 'ACTIVE' ? 'green' : 'red'}>{status}</Badge> : '—'],
                ['ОКВЭД', result.okved ? `${result.okved} · ${result.okved_name ?? ''}` : '—'],
                ['Адрес', result.address ?? '—'],
                [
                    'Руководитель',
                    result.director ? (
                        <>
                            {result.director.name}
                            {result.director.since && <div className='bank-sub'>с {date(result.director.since)}</div>}
                        </>
                    ) : (
                        '—'
                    ),
                ],
            ]}
        />
    );
}

function FnsChecks({ result }: { result: FnsResult }) {
    return (
        <ul className='bank-checks'>
            <Check
                ok={!(result.tax_debt > 0)}
                label='Налоговая задолженность'
                value={result.tax_debt > 0 ? rub(result.tax_debt) : 'нет'}
            />
            <Check
                ok={!result.mass_address}
                label='Адрес массовой регистрации'
                value={result.mass_address ? 'да' : 'нет'}
            />
            <Check
                ok={!result.director_disqualified}
                label='Дисквалификация руководителя'
                value={result.director_disqualified ? 'да' : 'нет'}
            />
            {result.employees !== undefined && result.employees !== null && (
                <Check ok={null} label='Сотрудников' value={result.employees} />
            )}
            {result.tax_regime && <Check ok={null} label='Налоговый режим' value={result.tax_regime} />}
        </ul>
    );
}

function GirboTable({ result }: { result: GirboResult }) {
    const years = [...(result.years ?? [])].sort((a, b) => b.year - a.year);
    if (!result.available || !years.length) {
        return <Sub>{result.reason ?? 'Отчётность в ГИР БО не найдена'}</Sub>;
    }
    return (
        <div className='table-wrap'>
            <table className='simple'>
                <thead>
                    <tr>
                        <th>Год</th>
                        <th className='num'>Выручка</th>
                        <th className='num'>Прибыль от продаж</th>
                        <th className='num'>Чистая прибыль</th>
                        <th className='num'>Рентабельность продаж</th>
                    </tr>
                </thead>
                <tbody>
                    {years.map((y) => (
                        <tr key={y.year}>
                            <td className='bank-strong'>{y.year}</td>
                            <td className='num'>{rub(y.revenue)}</td>
                            <td className='num'>{rub(y.sales_profit)}</td>
                            <td className={`num${y.net_profit < 0 ? ' bank-negative' : ''}`}>{rub(y.net_profit)}</td>
                            <td className='num'>
                                {y.revenue ? percent(Math.round((y.sales_profit / y.revenue) * 1000) / 10) : '—'}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const days = (n: number): string => `${n} дн.`;

function BkiReport({ result }: { result: BkiResult }) {
    const loans = result.loans ?? [];
    const totalBalance = loans.reduce((sum, loan) => sum + loan.balance, 0);
    const totalPayment = loans.reduce((sum, loan) => sum + loan.monthly_payment, 0);
    return (
        <div className='stack-16'>
            <ul className='bank-checks bank-checks--row'>
                <Check stacked={true} ok={null} label='Кредитная история' value={result.has_history ? 'есть' : 'нет'} />
                <Check
                    stacked={true}
                    ok={result.max_overdue_days_24m === 0}
                    label='Макс. просрочка за 24 мес.'
                    value={result.max_overdue_days_24m ? days(result.max_overdue_days_24m) : 'нет'}
                />
                <Check
                    stacked={true}
                    ok={result.current_overdue_days === 0}
                    label='Текущая просрочка'
                    value={result.current_overdue_days ? days(result.current_overdue_days) : 'нет'}
                />
                <Check stacked={true} ok={null} label='Платежи по кредитам' value={`${rub(totalPayment)} в мес.`} />
            </ul>
            {loans.length ? (
                <div className='table-wrap'>
                    <table className='simple'>
                        <thead>
                            <tr>
                                <th>Кредитор</th>
                                <th>Вид</th>
                                <th className='num'>Сумма</th>
                                <th className='num'>Остаток</th>
                                <th className='num'>Платёж в месяц</th>
                                <th>Открыт</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loans.map((loan, index) => (
                                <tr key={index}>
                                    <td className='bank-strong'>{loan.lender}</td>
                                    <td>{loan.kind}</td>
                                    <td className='num'>{rub(loan.amount)}</td>
                                    <td className='num'>{rub(loan.balance)}</td>
                                    <td className='num'>{rub(loan.monthly_payment)}</td>
                                    <td>{date(loan.opened_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                        {loans.length > 1 && (
                            <tfoot>
                                <tr className='bank-total'>
                                    <td colSpan={3}>Итого</td>
                                    <td className='num'>{rub(totalBalance)}</td>
                                    <td className='num'>{rub(totalPayment)}</td>
                                    <td />
                                </tr>
                            </tfoot>
                        )}
                    </table>
                </div>
            ) : (
                <Sub>Действующих кредитов нет</Sub>
            )}
        </div>
    );
}

function BankTurnover({ result, accountMonths }: { result: BankResult; accountMonths: number | null }) {
    const series = result.months ?? [];
    if (!result.is_client) {
        return (
            <Sub>
                Компания не обслуживается в банке — данных об оборотах нет. Выручку оценивают по отчётности или выписке
                клиента.
            </Sub>
        );
    }
    const total = series.reduce((sum, m) => sum + m.inflow, 0);
    const withInflow = series.filter((m) => m.inflow > 0).length;
    return (
        <div className='stack'>
            <div className='metrics'>
                <Metric
                    label='Счёт открыт'
                    value={date(result.account_opened_at)}
                    hint={accountMonths !== null ? months(accountMonths) : undefined}
                />
                <Metric label='В среднем за месяц' value={series.length ? rub(total / series.length) : '—'} />
                <Metric label='Месяцев с поступлениями' value={`${withInflow} из ${series.length}`} />
            </div>
            {series.length > 0 && <InflowChart months={series} title='Поступления на счёт по месяцам' />}
        </div>
    );
}

export function SourcesTab({ data, meta }: { data: Dossier; meta: Meta | undefined }) {
    const app = data.application;
    const { sources } = data;
    const dataCheck = sourceResult<DataCheckResult>(sources.DATA_CHECK);
    const egrul = sourceResult<EgrulResult>(sources.EGRUL);
    const fns = sourceResult<FnsResult>(sources.FNS);
    const girbo = sourceResult<GirboResult>(sources.GIRBO);
    const bki = sourceResult<BkiResult>(sources.BKI);
    const bank = sourceResult<BankResult>(sources.BANK);
    return (
        <div className='stack'>
            <div className='bank-grid-2'>
                <Card
                    title='Шаги проверки'
                    extra={app.run_no > 1 ? <span className='bank-sub'>Прогон № {app.run_no}</span> : undefined}
                >
                    {app.steps.length ? (
                        <StepList steps={app.steps} showErrors={true} />
                    ) : (
                        <Sub>Проверка ещё не начиналась</Sub>
                    )}
                </Card>
                <SourceCard title='Проверка данных заявки' source={sources.DATA_CHECK}>
                    {dataCheck?.checks && (
                        <ul className='bank-checks'>
                            {dataCheck.checks.map((check) => (
                                <Check key={check.title} ok={check.ok} label={check.title} />
                            ))}
                        </ul>
                    )}
                </SourceCard>
            </div>
            <div className='bank-grid-2'>
                <SourceCard title='ЕГРЮЛ / ЕГРИП' source={sources.EGRUL}>
                    {egrul && <EgrulFacts result={egrul} meta={meta} />}
                </SourceCard>
                <SourceCard title='ФНС «Прозрачный бизнес»' source={sources.FNS}>
                    {fns && <FnsChecks result={fns} />}
                </SourceCard>
            </div>
            <SourceCard title='ГИР БО — бухгалтерская отчётность' source={sources.GIRBO}>
                {girbo && <GirboTable result={girbo} />}
            </SourceCard>
            <SourceCard title='Бюро кредитных историй' source={sources.BKI}>
                {bki && <BkiReport result={bki} />}
            </SourceCard>
            <SourceCard title='Обороты по счёту в банке' source={sources.BANK}>
                {bank && <BankTurnover result={bank} accountMonths={app.company.account_months} />}
            </SourceCard>
        </div>
    );
}
