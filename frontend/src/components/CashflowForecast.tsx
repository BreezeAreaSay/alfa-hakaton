import { Typography } from '@alfalab/core-components/typography';

import type { CashflowForecast as Forecast } from '../api/types';
import { plural, rub } from '../utils/format';
import { Badge } from './ui';

const MONTHS = [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь',
];
const MONTHS_IN = [
    'январе',
    'феврале',
    'марте',
    'апреле',
    'мае',
    'июне',
    'июле',
    'августе',
    'сентябре',
    'октябре',
    'ноябре',
    'декабре',
];

const monthName = (iso: string, inCase = false): string =>
    `${(inCase ? MONTHS_IN : MONTHS)[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** Вердикт прогноза одной строкой — для списка документов и досье. */
export function forecastVerdict(f: Forecast): { color: 'green' | 'orange'; label: string; text: string } {
    if (f.gap > 0 && f.min_balance_month) {
        const where = f.balance_known
            ? 'с учётом остатка на счёте'
            : 'остатка на счёте в выписке нет, считаем поступления и списания';
        return {
            color: 'orange',
            label: 'возможен кассовый разрыв',
            text: `В ${monthName(f.min_balance_month, true)} не хватит около ${rub(f.gap)} (${where}).`,
        };
    }
    return {
        color: 'green',
        label: 'разрыва не ожидается',
        text: f.balance_known
            ? `Поступления покрывают списания, минимальный остаток — ${rub(f.min_balance)}.`
            : 'Поступления покрывают списания в каждом из трёх месяцев.',
    };
}

export function recommendationText(f: Forecast): string | null {
    const r = f.recommendation;
    if (r.reason === 'GAP_COVERED_BY_OVERDRAFT') {
        return `Подойдёт овердрафт до ${rub(r.amount)} — в пределах 40 % среднемесячных поступлений (${rub(f.overdraft_cap)}).`;
    }
    if (r.reason === 'GAP_ABOVE_OVERDRAFT_LIMIT') {
        return `Разрыв больше лимита овердрафта (${rub(f.overdraft_cap)}) — подойдёт кредитная линия до ${rub(r.amount)}.`;
    }
    return null;
}

function trendText(value: number, noun: string): string {
    if (value === 0) return `${noun} без выраженного тренда`;
    return `${noun} ${value > 0 ? 'растут' : 'снижаются'} примерно на ${rub(Math.abs(value))} в месяц`;
}

/**
 * Прогноз денежного потока по выписке на три месяца: вердикт, подсказка по лимиту, таблица и как считали.
 * Прогноз не влияет на решение по заявке — это подсказка клиенту и аналитику (docs/credit-policy.md).
 */
export function CashflowForecast({ forecast: f, compact = false }: { forecast: Forecast; compact?: boolean }) {
    const verdict = forecastVerdict(f);
    const recommendation = recommendationText(f);
    const deficit = f.deficit_months.length;
    return (
        <div className='cashflow stack-8'>
            <div className='row' style={{ gap: 8, flexWrap: 'wrap' }}>
                <Typography.Text view='primary-small' weight='bold' tag='span'>
                    Прогноз денежного потока на {f.horizon_months} месяца
                </Typography.Text>
                <Badge color={verdict.color}>{verdict.label}</Badge>
            </div>
            <Typography.Text view='primary-small' tag='p'>
                {verdict.text}
                {recommendation ? ` ${recommendation}` : ''}
            </Typography.Text>
            {!compact && (
                <Typography.Text view='primary-small' color='secondary' tag='p'>
                    {deficit > 0
                        ? `В выписке ${deficit} ${plural(deficit, 'месяц', 'месяца', 'месяцев')} со списаниями больше поступлений: ${f.deficit_months.map((m) => monthName(m)).join(', ')}. `
                        : 'В выписке нет месяцев, когда списания превышали поступления. '}
                    {trendText(f.trend_inflow, 'Поступления')}, {trendText(f.trend_outflow, 'списания').toLowerCase()}.
                </Typography.Text>
            )}
            {!compact && (
                <div className='table-wrap'>
                    <table className='simple cashflow__table'>
                        <thead>
                            <tr>
                                <th>Месяц</th>
                                <th className='num'>Поступления</th>
                                <th className='num'>Списания</th>
                                <th className='num'>{f.balance_known ? 'Остаток' : 'Накопленный поток'}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {f.months.map((m) => (
                                <tr key={m.month}>
                                    <td>{monthName(m.month)}</td>
                                    <td className='num'>{rub(m.inflow)}</td>
                                    <td className='num'>{rub(m.outflow)}</td>
                                    <td className={`num${m.balance < 0 ? ' cashflow__negative' : ''}`}>
                                        {rub(m.balance)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {!compact && (
                <Typography.Text view='primary-small' color='secondary' tag='p'>
                    Как считаем: базовый уровень — среднее за последние три месяца, тренд — по всем месяцам выписки,
                    стартовый остаток — из выписки 1С (в CSV его нет). Прогноз не влияет на решение по заявке.
                </Typography.Text>
            )}
        </div>
    );
}
