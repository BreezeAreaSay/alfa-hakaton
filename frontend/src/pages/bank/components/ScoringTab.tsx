import { Typography } from '@alfalab/core-components/typography';

import type { Dossier } from '../../../api/types';
import { Empty, Metric } from '../../../components/ui';
import { RISK_COLORS, dateTime, months, percent, rub } from '../../../utils/format';
import { Card, RiskBadge, decimal, signed } from './common';

const BASE_SCORE = 600;
const MAX_POINTS = 150;
const SCALE_MIN = 300;
const SCALE_MAX = 900;

// Границы классов риска из скоринговой карты (docs/credit-policy.md)
const CLASSES: { name: string; from: number; to: number }[] = [
    { name: 'E', from: SCALE_MIN, to: 520 },
    { name: 'D', from: 520, to: 600 },
    { name: 'C', from: 600, to: 680 },
    { name: 'B', from: 680, to: 760 },
    { name: 'A', from: 760, to: SCALE_MAX },
];

const REVENUE_SOURCES: Record<string, string> = {
    GIRBO: 'по отчётности ГИР БО',
    BANK: 'по оборотам на счёте в банке',
    STATEMENT: 'по выписке клиента',
};

const position = (score: number): number =>
    ((Math.min(Math.max(score, SCALE_MIN), SCALE_MAX) - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;

function ScoreScale({ score, riskClass }: { score: number; riskClass: string }) {
    return (
        <div className='bank-scale' role='img' aria-label={`Балл ${score}, класс риска ${riskClass}`}>
            <div className='bank-scale__track'>
                {CLASSES.map((item) => {
                    const tone = `bank-scale__seg--${RISK_COLORS[item.name] ?? 'grey'}`;
                    const active = item.name === riskClass ? ' bank-scale__seg--active' : '';
                    return (
                        <div
                            key={item.name}
                            className={`bank-scale__seg ${tone}${active}`}
                            style={{ width: `${((item.to - item.from) / (SCALE_MAX - SCALE_MIN)) * 100}%` }}
                        />
                    );
                })}
                <span className='bank-scale__marker' style={{ left: `${position(score)}%` }} />
            </div>
            <div className='bank-scale__labels'>
                {CLASSES.map((item) => (
                    <span
                        key={item.name}
                        className={`bank-scale__class${item.name === riskClass ? ' bank-scale__class--active' : ''}`}
                        style={{ left: `${position((item.from + item.to) / 2)}%` }}
                    >
                        {item.name}
                    </span>
                ))}
                {CLASSES.slice(1).map((item) => (
                    <span key={item.from} className='bank-scale__tick' style={{ left: `${position(item.from)}%` }}>
                        {item.from}
                    </span>
                ))}
            </div>
        </div>
    );
}

function FactorBar({ points }: { points: number }) {
    const width = `${Math.min(100, (Math.abs(points) / MAX_POINTS) * 100)}%`;
    return (
        <div className='bank-diverge' aria-hidden={true}>
            <div className='bank-diverge__half bank-diverge__half--neg'>
                {points < 0 && <span className='bank-diverge__bar bank-diverge__bar--neg' style={{ width }} />}
            </div>
            <div className='bank-diverge__half'>
                {points > 0 && <span className='bank-diverge__bar bank-diverge__bar--pos' style={{ width }} />}
            </div>
        </div>
    );
}

const pointsTone = (points: number): string => (points > 0 ? 'bank-points--pos' : points < 0 ? 'bank-points--neg' : '');

const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

export function ScoringTab({ data }: { data: Dossier }) {
    const scoring = data.scoring;
    if (!scoring) {
        return (
            <Card>
                <Empty
                    title='Скоринг ещё не выполнен'
                    text='Оценка риска появится, когда конвейер получит данные из источников'
                />
            </Card>
        );
    }
    const f = scoring.features;
    const revenue = numberOrNull(f.revenue);
    const profit = numberOrNull(f.operating_profit_month);
    const payments = numberOrNull(f.existing_payments) ?? 0;
    const dscr = numberOrNull(f.dscr_current);
    const business = numberOrNull(f.business_months);
    const share = numberOrNull(f.amount_share);
    const total = scoring.factors.reduce((sum, factor) => sum + factor.points, 0);
    const finishedAt = data.sources.SCORING?.finished_at;

    return (
        <div className='stack'>
            <Card
                title='Оценка риска'
                extra={
                    <span className='bank-sub'>
                        Модель {scoring.version}
                        {finishedAt ? ` · ${dateTime(finishedAt)}` : ''}
                    </span>
                }
            >
                <div className='bank-score'>
                    <div>
                        <div className='bank-score__value'>{scoring.score}</div>
                        <div className='bank-sub'>баллов из {SCALE_MAX}</div>
                    </div>
                    <div className='metrics bank-score__metrics'>
                        <Metric label='Класс риска' value={<RiskBadge riskClass={scoring.risk_class} />} />
                        <Metric label='Вероятность дефолта' value={percent(scoring.pd)} hint='условная, по классу' />
                        <Metric label='Базовый балл' value={BASE_SCORE} hint={`факторы: ${signed(total)}`} />
                    </div>
                </div>
                <ScoreScale score={scoring.score} riskClass={scoring.risk_class} />
            </Card>

            <Card
                title='Факторы скоринга'
                extra={
                    <span className='bank-sub'>
                        {BASE_SCORE} {signed(total)} = {scoring.score}
                    </span>
                }
            >
                <div className='table-wrap'>
                    <table className='simple bank-factors'>
                        <thead>
                            <tr>
                                <th>Фактор</th>
                                <th>Значение</th>
                                <th className='num'>Баллы</th>
                                <th className='bank-factors__bar-head'>
                                    <span>−{MAX_POINTS}</span>
                                    <span>0</span>
                                    <span>+{MAX_POINTS}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {scoring.factors.map((factor) => (
                                <tr key={factor.code}>
                                    <td>
                                        <div className='bank-strong'>{factor.title}</div>
                                        {factor.phrase && <div className='bank-sub'>{factor.phrase}</div>}
                                    </td>
                                    <td>{factor.value}</td>
                                    <td className={`num bank-points ${pointsTone(factor.points)}`}>
                                        {signed(factor.points)}
                                    </td>
                                    <td className='bank-factors__bar'>
                                        <FactorBar points={factor.points} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className='bank-total'>
                                <td colSpan={2}>Итого: базовый балл {BASE_SCORE} и факторы</td>
                                <td className='num'>{scoring.score}</td>
                                <td />
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </Card>

            <Card title='Ключевые показатели'>
                <div className='metrics bank-metrics-3'>
                    <Metric
                        label='Выручка за год'
                        value={revenue !== null ? rub(revenue) : 'нет данных'}
                        hint={typeof f.revenue_source === 'string' ? REVENUE_SOURCES[f.revenue_source] : undefined}
                    />
                    <Metric label='Операционная прибыль в месяц' value={profit !== null ? rub(profit) : 'нет данных'} />
                    <Metric label='Платежи по текущим кредитам' value={rub(payments)} hint='в месяц' />
                    <Metric
                        label='DSCR текущий'
                        value={dscr !== null ? decimal(dscr) : payments === 0 ? 'нет кредитов' : 'нет данных'}
                        hint='прибыль / платежи, норма ≥ 1,3'
                    />
                    <Metric label='Срок бизнеса' value={business !== null ? months(business) : 'нет данных'} />
                    <Metric
                        label='Сумма к выручке'
                        value={share !== null ? percent(Math.round(share * 1000) / 10) : 'нет данных'}
                    />
                </div>
                <Typography.Text view='primary-small' color='secondary' tag='p' className='bank-gap-top'>
                    Показатели рассчитаны на момент скоринга. Класс риска и баллы клиент не видит.
                </Typography.Text>
            </Card>
        </div>
    );
}
