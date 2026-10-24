import { Button } from '@alfalab/core-components/button';
import { Typography } from '@alfalab/core-components/typography';
import { CheckmarkCircleMIcon } from '@alfalab/icons-glyph/CheckmarkCircleMIcon';
import { useState } from 'react';

import type { Loan } from '../../../api/types';
import { date, months, percent, rub } from '../../../utils/format';

export function LoanSection({ loan }: { loan: Loan }) {
    const [all, setAll] = useState(false);
    const rows = all ? loan.schedule : loan.schedule.slice(0, 6);
    return (
        <section className='card stack'>
            <div className='row' style={{ flexWrap: 'nowrap' }}>
                <CheckmarkCircleMIcon color='#0cc44d' width={32} height={32} />
                <div>
                    <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                        Кредит выдан — деньги на счёте
                    </Typography.Title>
                    <Typography.Text view='primary-medium' color='secondary' tag='p'>
                        {date(loan.issued_at)} перечислили {rub(loan.amount)} · ссудный счёт {loan.account_number}
                    </Typography.Text>
                </div>
            </div>
            <div className='metrics'>
                <div>
                    <div className='metric__label'>Сумма</div>
                    <div className='metric__value'>{rub(loan.amount)}</div>
                </div>
                <div>
                    <div className='metric__label'>Ставка</div>
                    <div className='metric__value'>{percent(loan.rate)}</div>
                </div>
                <div>
                    <div className='metric__label'>Срок</div>
                    <div className='metric__value'>{months(loan.term_months)}</div>
                </div>
                <div>
                    <div className='metric__label'>Ближайший платёж</div>
                    <div className='metric__value'>{rub(loan.schedule[0]?.payment)}</div>
                    <div className='metric__label'>{date(loan.schedule[0]?.due_date)}</div>
                </div>
            </div>
            <div className='table-wrap'>
                <table className='simple'>
                    <thead>
                        <tr>
                            <th className='col-detail'>№</th>
                            <th>Дата</th>
                            <th className='num'>Платёж</th>
                            <th className='num col-detail'>Основной долг</th>
                            <th className='num col-detail'>Проценты</th>
                            <th className='num'>Остаток</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.n}>
                                <td className='col-detail'>{row.n}</td>
                                <td>{date(row.due_date)}</td>
                                <td className='num'>{rub(row.payment)}</td>
                                <td className='num col-detail'>{rub(row.principal)}</td>
                                <td className='num col-detail'>{rub(row.interest)}</td>
                                <td className='num'>{rub(row.balance)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {loan.schedule.length > 6 && (
                <div>
                    <Button view='secondary' size={40} onClick={() => setAll(!all)}>
                        {all ? 'Свернуть график' : `Весь график — ${loan.schedule.length} платежей`}
                    </Button>
                </div>
            )}
        </section>
    );
}
