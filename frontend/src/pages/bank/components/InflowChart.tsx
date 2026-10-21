import { rub } from '../../../utils/format';
import { compactRub, monthLabel } from './common';

const PLOT_HEIGHT = 120;

/** Поступления на счёт по месяцам: столбцы от нуля, под каждым — месяц и сумма, точное значение — в подсказке. */
export function InflowChart({ months, title }: { months: { month: string; inflow: number }[]; title: string }) {
    if (!months.length) return null;
    const max = Math.max(...months.map((m) => m.inflow), 1);
    return (
        <div className='bank-chart'>
            <div className='bank-bars' role='list' aria-label={title}>
                {months.map((m) => (
                    <div
                        key={m.month}
                        className='bank-bars__col'
                        role='listitem'
                        tabIndex={0}
                        aria-label={`${monthLabel(m.month)}: ${rub(m.inflow)}`}
                    >
                        <div className='bank-bars__plot'>
                            <span
                                className='bank-bars__bar'
                                style={{ height: Math.max(3, Math.round((m.inflow / max) * PLOT_HEIGHT)) }}
                            />
                        </div>
                        <span className='bank-bars__label'>{monthLabel(m.month)}</span>
                        <span className='bank-bars__amount'>{compactRub(m.inflow)}</span>
                        <span className='bank-bars__tip' role='tooltip'>
                            <b>{rub(m.inflow)}</b>
                            <span>{monthLabel(m.month)}</span>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
