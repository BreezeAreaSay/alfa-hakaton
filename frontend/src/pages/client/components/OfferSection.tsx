import { Button } from '@alfalab/core-components/button';
import { Typography } from '@alfalab/core-components/typography';
import { CheckmarkCircleMIcon } from '@alfalab/icons-glyph/CheckmarkCircleMIcon';
import { ArrowDownCircleMIcon } from '@alfalab/icons-glyph/ArrowDownCircleMIcon';
import { ExclamationCircleMIcon } from '@alfalab/icons-glyph/ExclamationCircleMIcon';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAcceptOffer, useDecline } from '../../../api/hooks';
import type { Application, Money, Offer, RateBreakdown, RateHint } from '../../../api/types';
import { Badge, ErrorPlate, KeyValue } from '../../../components/ui';
import { dateTime, months, num, percent, plainNumber, rub, timeLeft } from '../../../utils/format';

export function OfferSection({ application }: { application: Application }) {
    const offers = application.offers.filter((o) => o.status === 'ACTIVE');
    const [selected, setSelected] = useState<string>(offers[0]?.id ?? '');
    const [confirmDecline, setConfirmDecline] = useState(false);
    const accept = useAcceptOffer();
    const decline = useDecline();
    const counter = offers.some((o) => o.kind === 'COUNTER');
    const explanation = application.explanation;

    return (
        <section className='card stack'>
            <div className='stack-8'>
                <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                    {counter ? 'Банк предлагает другие условия' : 'Кредит одобрен'}
                </Typography.Title>
                <Typography.Text view='primary-medium' color='secondary' tag='p'>
                    {counter
                        ? `Вы запрашивали ${rub(application.amount)} на ${months(application.term_months)}. ${
                              offers.length > 1 ? 'Выберите подходящий вариант.' : 'Вот что мы можем предложить.'
                          }`
                        : 'Условия совпадают с вашей заявкой. Проверьте и примите предложение.'}
                </Typography.Text>
            </div>

            <div className='stack-16' role='radiogroup' aria-label='Варианты условий'>
                {offers.map((offer) => (
                    <OfferOption
                        key={offer.id}
                        offer={offer}
                        selected={selected === offer.id}
                        selectable={offers.length > 1}
                        onSelect={() => setSelected(offer.id)}
                    />
                ))}
            </div>

            {(explanation.positive.length > 0 || explanation.negative.length > 0 || explanation.limit_phrase) && (
                <div className='tile stack-8'>
                    <Typography.Text view='primary-medium' weight='bold' tag='div'>
                        Что повлияло на условия
                    </Typography.Text>
                    {explanation.positive.map((text) => (
                        <div key={text} className='row' style={{ flexWrap: 'nowrap' }}>
                            <CheckmarkCircleMIcon color='#0cc44d' />
                            <Typography.Text view='primary-small'>{text}</Typography.Text>
                        </div>
                    ))}
                    {[...explanation.negative, ...(explanation.limit_phrase ? [explanation.limit_phrase] : [])].map(
                        (text) => (
                            <div key={text} className='row' style={{ flexWrap: 'nowrap' }}>
                                <ExclamationCircleMIcon color='#f7a600' />
                                <Typography.Text view='primary-small'>{text}</Typography.Text>
                            </div>
                        ),
                    )}
                </div>
            )}

            {explanation.rate_breakdown && offers[0] && (
                <RateBreakdownCard
                    breakdown={explanation.rate_breakdown}
                    hints={explanation.rate_hints}
                    productName={offers[0].product_name}
                    compareHref={`/client/new?purpose=${application.purpose}&amount=${num(application.amount)}&term=${application.term_months}`}
                />
            )}

            {offers[0] && (
                <Typography.Text view='primary-small' color='secondary' tag='p'>
                    Предложение действует до {dateTime(offers[0].valid_until)} ({timeLeft(offers[0].valid_until)}).
                </Typography.Text>
            )}
            <ErrorPlate error={accept.error ?? decline.error} />
            <div className='row'>
                <Button
                    view='primary'
                    size={56}
                    disabled={!selected}
                    loading={accept.isPending}
                    onClick={() => accept.mutate(selected)}
                >
                    Принять предложение
                </Button>
                {!confirmDecline ? (
                    <Button view='secondary' size={56} onClick={() => setConfirmDecline(true)}>
                        Отказаться
                    </Button>
                ) : (
                    <>
                        <Typography.Text view='primary-small' color='secondary'>
                            Точно отказаться?
                        </Typography.Text>
                        <Button
                            view='secondary'
                            size={48}
                            loading={decline.isPending}
                            onClick={() => decline.mutate(application.id)}
                        >
                            Да, отказаться
                        </Button>
                        <Button view='transparent' size={48} onClick={() => setConfirmDecline(false)}>
                            Нет
                        </Button>
                    </>
                )}
            </div>
        </section>
    );
}

function OfferOption({
    offer,
    selected,
    selectable,
    onSelect,
}: {
    offer: Offer;
    selected: boolean;
    selectable: boolean;
    onSelect: () => void;
}) {
    return (
        <div
            role={selectable ? 'radio' : undefined}
            aria-checked={selectable ? selected : undefined}
            tabIndex={selectable ? 0 : undefined}
            className={`offer-card tile stack-16${selected && selectable ? ' offer-card--selected' : ''}`}
            style={{ cursor: selectable ? 'pointer' : 'default', background: 'var(--color-light-base-bg-secondary)' }}
            onClick={onSelect}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect();
            }}
        >
            <div className='row row--between'>
                <Typography.Text view='primary-medium' weight='bold'>
                    {offer.product_name}
                </Typography.Text>
                <Badge color={offer.kind === 'AS_REQUESTED' ? 'green' : 'blue'}>
                    {offer.kind === 'AS_REQUESTED' ? 'Как вы запросили' : (offer.note ?? `Вариант ${offer.option_no}`)}
                </Badge>
            </div>
            <div className='metrics'>
                <div>
                    <div className='metric__label'>Сумма</div>
                    <div className='metric__value'>{rub(offer.amount)}</div>
                </div>
                <div>
                    <div className='metric__label'>Срок</div>
                    <div className='metric__value'>{months(offer.term_months)}</div>
                </div>
                <div>
                    <div className='metric__label'>Ставка</div>
                    <div className='metric__value'>{percent(offer.rate)}</div>
                </div>
                <div>
                    <div className='metric__label'>{offer.payment_label}</div>
                    <div className='metric__value'>{rub(offer.monthly_payment)}</div>
                </div>
            </div>
            <Typography.Text view='primary-small' color='secondary'>
                Переплата за весь срок — {rub(offer.overpayment)}
            </Typography.Text>
        </div>
    );
}

const pp = (value: Money): string => `${plainNumber(value)} п.п.`;

/** Из чего складывается ставка и как получить её ниже — главный вопрос предпринимателя по исследованию. */
function RateBreakdownCard({
    breakdown: b,
    hints,
    productName,
    compareHref,
}: {
    breakdown: RateBreakdown;
    hints: RateHint[];
    productName: string;
    compareHref: string;
}) {
    const navigate = useNavigate();
    const adjustment = num(b.adjustment);
    const rows: [string, string][] = [
        ['Ключевая ставка Банка России', percent(b.key_rate)],
        [`Надбавка продукта «${productName}»`, `+${pp(b.product_spread)}`],
        [
            'Надбавка за риск по итогам проверки',
            num(b.risk_margin) > 0 ? `+${pp(b.risk_margin)}` : '0 п.п. — минимальная',
        ],
    ];
    if (adjustment !== 0)
        rows.push(['Решение специалиста банка', `${adjustment > 0 ? '+' : '−'}${pp(Math.abs(adjustment))}`]);
    return (
        <div className='tile stack-8'>
            <Typography.Text view='primary-medium' weight='bold' tag='div'>
                Из чего складывается ставка {percent(b.rate)}
            </Typography.Text>
            <KeyValue items={rows} />
            {hints.length > 0 && (
                <>
                    <Typography.Text view='primary-medium' weight='bold' tag='div' style={{ marginTop: 8 }}>
                        Как получить ставку ниже
                    </Typography.Text>
                    {hints.map((hint) => (
                        <div key={hint.text} className='row' style={{ flexWrap: 'nowrap' }}>
                            <ArrowDownCircleMIcon color='#0cc44d' />
                            <Typography.Text view='primary-small'>
                                {hint.text}
                                {hint.saving ? `. Переплата меньше на ${rub(hint.saving)}` : ''}
                            </Typography.Text>
                        </div>
                    ))}
                    {hints.some((hint) => hint.kind === 'product') && (
                        <div>
                            <Button view='text' size={40} onClick={() => navigate(compareHref)}>
                                Сравнить продукты в подборе
                            </Button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
