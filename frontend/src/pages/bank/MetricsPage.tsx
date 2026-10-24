import { type ReactNode, useState } from 'react';

import { useBankMetrics } from '../../api/hooks';
import type { BankMetrics, DailyMetrics, MetricCount } from '../../api/types';
import { ErrorPlate, KeyValue, Loader, PageHead } from '../../components/ui';
import { plural, rub } from '../../utils/format';
import { Card, Sub } from './components/common';
import './bank.css';

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];
const PLOT_HEIGHT = 120;
const ruNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

const sharePercent = (value: number | null): string => (value === null ? '—' : `${Math.round(value * 100)}\u00a0%`);

/** Длительность словами: секунды — до минуты, минуты — до часа, часы — до двух суток, дальше дни. */
function duration(seconds: number | null): string {
    if (seconds === null) return '—';
    if (seconds < 60) return `${Math.round(seconds)} с`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} мин`;
    const hours = seconds / 3600;
    if (hours < 48) return `${ruNumber.format(Math.round(hours * 10) / 10)} ч`;
    const days = Math.round(hours / 24);
    return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

const hoursText = (hours: number | null): string => duration(hours === null ? null : hours * 3600);

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
    return (
        <div className='bank-tile bank-tile--static'>
            <span className='bank-tile__label'>{label}</span>
            <span>
                <span className='bank-tile__value'>{value}</span>
                {hint && <span className='bank-tile__hint'>{hint}</span>}
            </span>
        </div>
    );
}

/** Строки «название — число» с полосой доли от наибольшего значения. */
function CountRows({ rows, empty }: { rows: MetricCount[]; empty: string }) {
    if (!rows.length) return <Sub>{empty}</Sub>;
    const max = Math.max(...rows.map((row) => row.count), 1);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return (
        <ul className='metric-rows'>
            {rows.map((row) => (
                <li key={row.code} className='metric-row'>
                    <span>
                        {row.title}
                        {/* коды политики (S01, R02) аналитику знакомы, служебные коды исходов не показываем */}
                        {/^[SR]\d{2}$/.test(row.code) && <span className='bank-sub'> {row.code}</span>}
                    </span>
                    <span className='metric-row__count'>
                        {row.count} · {Math.round((row.count / total) * 100)}
                        {'\u00a0'}%
                    </span>
                    <span className='metric-row__bar' aria-hidden={true}>
                        <span className='metric-row__fill' style={{ width: `${(row.count / max) * 100}%` }} />
                    </span>
                </li>
            ))}
        </ul>
    );
}

const dayLabel = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/** Подано заявок по дням; в подсказке — ещё решения и выдачи за день. */
function DailyChart({ daily }: { daily: DailyMetrics[] }) {
    const max = Math.max(...daily.map((d) => d.submitted), 1);
    const every = Math.ceil(daily.length / 10);
    return (
        <div className='bank-chart'>
            <div className='bank-bars' role='list' aria-label='Подано заявок по дням'>
                {daily.map((d, index) => (
                    <div
                        key={d.date}
                        className='bank-bars__col'
                        role='listitem'
                        tabIndex={0}
                        aria-label={`${dayLabel(d.date)}: подано ${d.submitted}, решений ${d.decided}, выдано ${d.issued}`}
                    >
                        <div className='bank-bars__plot'>
                            <span
                                className='bank-bars__bar'
                                style={{
                                    height: d.submitted
                                        ? Math.max(3, Math.round((d.submitted / max) * PLOT_HEIGHT))
                                        : 0,
                                }}
                            />
                        </div>
                        <span className='bank-bars__label'>
                            {(daily.length - 1 - index) % every === 0 ? dayLabel(d.date) : ' '}
                        </span>
                        <span className='bank-bars__tip' role='tooltip'>
                            <b>{dayLabel(d.date)}</b>
                            <span>
                                подано {d.submitted} · решений {d.decided} · выдано {d.issued}
                            </span>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function Tiles({ m }: { m: BankMetrics }) {
    return (
        <div className='bank-tiles' role='group' aria-label='Ключевые показатели'>
            <Tile
                label='Подано заявок'
                value={m.submitted}
                hint={`${m.in_progress} ${plural(m.in_progress, 'в работе', 'в работе', 'в работе')}`}
            />
            <Tile
                label='Решений принято'
                value={m.decided}
                hint={`автоматически ${m.auto_decided}, аналитиком ${m.manual_decided}`}
            />
            <Tile label='Доля автоматических' value={sharePercent(m.automation_share)} hint='без участия аналитика' />
            <Tile
                label='До решения, медиана'
                value={duration(m.to_decision_median_seconds)}
                hint={`95\u00a0% заявок — ${duration(m.to_decision_p95_seconds)}`}
            />
            <Tile
                label='Предложение → принято'
                value={sharePercent(m.offer_conversion)}
                hint={`контрпредложения — ${sharePercent(m.counter_conversion)}`}
            />
            <Tile label='Выдано кредитов' value={m.issued} hint={rub(m.issued_amount)} />
            <Tile
                label='Запросов информации'
                value={m.need_info}
                hint={`ответ клиента — ${hoursText(m.info_response_median_hours)}`}
            />
            <Tile
                label='Просрочки SLA'
                value={m.sla_overdue_now}
                hint={`сейчас; за период нарушено ${m.sla_breached}`}
            />
        </div>
    );
}

export function MetricsPage() {
    const [days, setDays] = useState<Period>(30);
    const metrics = useBankMetrics(days);
    const m = metrics.data;
    return (
        <div className='page page--wide bank-page'>
            <PageHead
                title='Показатели конвейера'
                subtitle='Скорость, автоматизация, конверсия и нагрузка на аналитиков по заявкам, поданным за период. Обновляются сами.'
            />
            <div className='chips metrics-period' role='group' aria-label='Период'>
                {PERIODS.map((period) => (
                    <button
                        key={period}
                        type='button'
                        className={`chip${period === days ? ' chip--active' : ''}`}
                        aria-pressed={period === days}
                        onClick={() => setDays(period)}
                    >
                        {period} {plural(period, 'день', 'дня', 'дней')}
                    </button>
                ))}
            </div>
            {metrics.isLoading && <Loader />}
            <ErrorPlate error={metrics.error} title='Не удалось получить показатели' />
            {m && (
                <div className='stack'>
                    <Tiles m={m} />
                    <Card title='Заявки по дням'>
                        <DailyChart daily={m.daily} />
                        <Sub>
                            Столбцы — подано заявок за день. Наведите на столбец: сколько решений принято и кредитов
                            выдано в этот день.
                        </Sub>
                    </Card>
                    <div className='metrics-grid'>
                        <Card title='Исходы решений'>
                            <CountRows rows={m.outcomes} empty='За период решений ещё не было.' />
                            <Sub>
                                Последнее окончательное решение по каждой заявке. Контрпредложение вместо отказа —
                                ценность небинарного исхода: клиент получает деньги, банк — сделку в рамках политики.
                            </Sub>
                        </Card>
                        <Card title='Причины отказов'>
                            <CountRows rows={m.rejection_reasons} empty='Отказов за период не было.' />
                            <Sub>
                                Стоп-факторы S01–S05 и коды причин R01–R07 из кредитной политики. Много отказов по одной
                                причине — повод пересмотреть порог или подбор продуктов.
                            </Sub>
                        </Card>
                        <Card title='Сроки'>
                            <KeyValue
                                items={[
                                    ['До первого решения, медиана', duration(m.to_decision_median_seconds)],
                                    ['До решения, 95\u00a0% заявок', duration(m.to_decision_p95_seconds)],
                                    ['От подачи до выдачи, медиана', hoursText(m.to_issue_median_hours)],
                                    ['Ответ клиента на запрос, медиана', hoursText(m.info_response_median_hours)],
                                    ['Рассмотрение аналитиком, медиана', hoursText(m.review_median_hours)],
                                ]}
                            />
                            <Sub>
                                Время до решения показывает скорость конвейера, время ответа клиента — полноту данных на
                                входе, время рассмотрения — эффективность рабочего места.
                            </Sub>
                        </Card>
                        <Card title='Предложения'>
                            <KeyValue
                                items={[
                                    ['Заявок с предложением', m.offered],
                                    ['Приняли предложение', m.accepted],
                                    ['Конверсия', sharePercent(m.offer_conversion)],
                                    ['Контрпредложений', m.counter_offered],
                                    ['Приняли контрпредложение', m.counter_accepted],
                                    ['Конверсия контрпредложений', sharePercent(m.counter_conversion)],
                                ]}
                            />
                            <Sub>
                                Считается по заявкам: у контрпредложения может быть два варианта, принять можно один.
                                Заявка попадает в «заявки с предложением», как только банк выдал предложение, ещё до
                                ответа клиента.
                            </Sub>
                        </Card>
                        <Card title='Продукты'>
                            <div className='table-wrap'>
                                <table className='simple'>
                                    <thead>
                                        <tr>
                                            <th>Продукт</th>
                                            <th className='num'>Заявок</th>
                                            <th className='num'>Одобрено</th>
                                            <th className='num'>Выдано</th>
                                            <th className='num'>Сумма выдач</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {m.products.map((p) => (
                                            <tr key={p.code}>
                                                <td>{p.name}</td>
                                                <td className='num'>{p.applications}</td>
                                                <td className='num'>{p.approved}</td>
                                                <td className='num'>{p.issued}</td>
                                                <td className='num'>{rub(p.issued_amount)}</td>
                                            </tr>
                                        ))}
                                        {!m.products.length && (
                                            <tr>
                                                <td colSpan={5} className='bank-sub'>
                                                    За период заявок не было.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                        <Card title='Аналитики'>
                            <div className='table-wrap'>
                                <table className='simple'>
                                    <thead>
                                        <tr>
                                            <th>Аналитик</th>
                                            <th className='num'>Решений</th>
                                            <th className='num'>В работе</th>
                                            <th className='num'>Просрочено</th>
                                            <th className='num'>Рассмотрение</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {m.analysts.map((a) => (
                                            <tr key={a.name}>
                                                <td>{a.name}</td>
                                                <td className='num'>{a.decided}</td>
                                                <td className='num'>{a.in_work}</td>
                                                <td className={`num${a.overdue ? ' bank-negative' : ''}`}>
                                                    {a.overdue}
                                                </td>
                                                <td className='num'>{hoursText(a.median_review_hours)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <Sub>
                                Решений — окончательных решений аналитика за период; рассмотрение — медиана от попадания
                                заявки к аналитику до решения.
                            </Sub>
                        </Card>
                    </div>
                </div>
            )}
        </div>
    );
}
