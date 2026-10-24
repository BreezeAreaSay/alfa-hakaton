import { Button } from '@alfalab/core-components/button';
import { Checkbox } from '@alfalab/core-components/checkbox';
import { Input } from '@alfalab/core-components/input';
import { Plate } from '@alfalab/core-components/plate';
import { Select } from '@alfalab/core-components/select';
import { SliderInput } from '@alfalab/core-components/slider-input';
import { Spinner } from '@alfalab/core-components/spinner';
import { Textarea } from '@alfalab/core-components/textarea';
import { Typography } from '@alfalab/core-components/typography';
import { type ReactNode, useMemo, useState } from 'react';

import { useDecision, useProducts, useRequestInfo, useRestart, useRetryNow, useTermsPreview } from '../../../api/hooks';
import type { Application, Dossier, Meta, Offer, Product, TermsPreview } from '../../../api/types';
import { ErrorPlate, KeyValue, StatusBadge } from '../../../components/ui';
import { dateTime, months, num, percent, rub, shortAmount, time, timeLeft } from '../../../utils/format';
import { FLAG_INFO_ITEMS, OUTCOME_LABELS, RiskBadge, useDebounced, useNow } from './common';

type Action = 'APPROVE' | 'COUNTER' | 'INFO' | 'REJECT';

const ACTIONS: { key: Action; label: string }[] = [
    { key: 'APPROVE', label: 'Одобрить' },
    { key: 'COUNTER', label: 'Изменить условия' },
    { key: 'INFO', label: 'Запросить информацию' },
    { key: 'REJECT', label: 'Отказать' },
];

const AMOUNT_STEP = 50_000;
const DUE_OPTIONS = [24, 48, 72];
const amountFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

// Подсказку «добавьте комментарий» снимает сам комментарий, остальные ошибки блокируют решение
const isCommentHint = (error: string): boolean => error.includes('добавьте комментарий');

function eligibleProducts(products: Product[], app: Application): Product[] {
    const { company } = app;
    const age = company.business_months;
    return products.filter((p) => {
        if (p.code === app.product.code) return true;
        if (age !== null && age < p.min_business_months) return false;
        if (age !== null && p.max_business_months !== null && age >= p.max_business_months) return false;
        if (
            p.requires_bank_account_months !== null &&
            (!company.is_bank_client || (company.account_months ?? 0) < p.requires_bank_account_months)
        ) {
            return false;
        }
        return !(p.collateral_required && !app.collateral_value);
    });
}

function termOptions(product: Product, current: number): number[] {
    const values = new Set<number>([product.min_term, product.max_term]);
    for (let term = Math.ceil(product.min_term / 6) * 6; term <= product.max_term; term += 6) values.add(term);
    if (current >= product.min_term && current <= product.max_term) values.add(current);
    return [...values].sort((a, b) => a - b);
}

/** Пустая строка — ставку не задаём (берётся расчётная), null — ошибка ввода. */
function parseRate(text: string): number | undefined | null {
    const value = text.trim().replace(',', '.');
    if (!value) return undefined;
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 && rate <= 60 ? rate : null;
}

function initialAmount(app: Application, limit: number | null): number {
    const requested = num(app.amount);
    const base = limit !== null && limit < requested ? limit : requested;
    const rounded = Math.floor(base / AMOUNT_STEP) * AMOUNT_STEP;
    return clamp(rounded, num(app.product.min_amount), num(app.product.max_amount));
}

function PreviewFigures({ preview, loading }: { preview: TermsPreview | undefined; loading: boolean }) {
    if (!preview) {
        return (
            <div className='tile row bank-row-tight'>
                <Spinner visible={true} size={16} lineWidth={2} />
                <span className='bank-sub'>Считаем условия…</span>
            </div>
        );
    }
    const items: [ReactNode, ReactNode][] = [
        ['Расчётный лимит', preview.limit !== null ? rub(preview.limit) : 'не рассчитан'],
        ['Минимальная ставка', preview.min_rate !== null ? `${percent(preview.min_rate)} годовых` : '—'],
        ['Ставка в решении', preview.rate !== null ? `${percent(preview.rate)} годовых` : '—'],
        [preview.payment_label, preview.monthly_payment !== null ? rub(preview.monthly_payment) : '—'],
        ['Переплата за весь срок', preview.overpayment !== null ? rub(preview.overpayment) : '—'],
    ];
    return (
        <div className={`tile stack-8${loading ? ' bank-dim' : ''}`} aria-busy={loading}>
            <KeyValue items={items} />
            {preview.limit_phrase && <div className='bank-sub'>{preview.limit_phrase}</div>}
        </div>
    );
}

// Сервер пишет суммы с обычными пробелами — склеиваем разряды и «₽», чтобы число не рвалось на две строки
const keepNumbers = (text: string): string => text.replace(/(\d) (?=\d{3}\b|₽)/g, '$1 ');

function PreviewErrors({ errors }: { errors: string[] }) {
    if (!errors.length) return null;
    return (
        <Plate view='negative' rounded={true} limitContentWidth={false} title='Так оформить нельзя'>
            <ul className='bank-errors'>
                {errors.map((error) => (
                    <li key={error}>{keepNumbers(error)}</li>
                ))}
            </ul>
        </Plate>
    );
}

function ApproveForm({ app, onDone, onCounter }: { app: Application; onDone: () => void; onCounter: () => void }) {
    const amount = num(app.amount);
    const preview = useTermsPreview(app.id, { product_code: app.product.code, amount, term_months: app.term_months });
    const decision = useDecision();
    const [comment, setComment] = useState('');
    const result = preview.data;
    const errors = (result?.errors ?? []).filter((error) => !isCommentHint(error));
    const overLimit = result?.limit !== null && result?.limit !== undefined && amount > num(result.limit);
    const needComment = overLimit && !errors.length && !comment.trim();
    const blocked = !result || preview.isFetching || errors.length > 0 || needComment;

    const submit = () =>
        decision.mutate({ id: app.id, action: 'APPROVE', comment: comment.trim() || undefined }, { onSuccess: onDone });

    return (
        <div className='stack-16'>
            <div className='bank-sub'>
                Клиент получит предложение на запрошенных условиях: {rub(amount)} на {months(app.term_months)}.
            </div>
            <PreviewFigures preview={result} loading={preview.isFetching} />
            <ErrorPlate error={preview.error} title='Не удалось рассчитать условия' />
            <PreviewErrors errors={errors} />
            {errors.length > 0 && (
                <Button view='secondary' size={40} block={true} onClick={onCounter}>
                    Предложить другие условия
                </Button>
            )}
            {overLimit && !errors.length && (
                <Plate view='attention' rounded={true} limitContentWidth={false} title='Сумма выше расчётного лимита'>
                    Превышение до 20{'\u00a0'}% допустимо — добавьте комментарий с обоснованием.
                </Plate>
            )}
            <Textarea
                label={overLimit && !errors.length ? 'Обоснование превышения лимита' : 'Комментарий (необязательно)'}
                labelView='inner'
                size={56}
                block={true}
                minRows={2}
                maxLength={2000}
                value={comment}
                onChange={(_, { value }) => setComment(value)}
            />
            <ErrorPlate error={decision.error} title='Решение не принято' />
            <Button
                view='primary'
                size={48}
                block={true}
                disabled={blocked}
                loading={decision.isPending}
                onClick={submit}
            >
                Одобрить
            </Button>
        </div>
    );
}

function CounterForm({ data, onDone }: { data: Dossier; onDone: () => void }) {
    const app = data.application;
    const products = useProducts();
    const options = useMemo(() => eligibleProducts(products.data ?? [app.product], app), [products.data, app]);
    const decision = useDecision();
    const [productCode, setProductCode] = useState(app.product.code);
    const [amount, setAmount] = useState<number | ''>(() => initialAmount(app, data.limit?.limit ?? null));
    const [term, setTerm] = useState(() => clamp(app.term_months, app.product.min_term, app.product.max_term));
    const [rateText, setRateText] = useState('');
    const [comment, setComment] = useState('');

    const product = options.find((p) => p.code === productCode) ?? app.product;
    const min = num(product.min_amount);
    const max = num(product.max_amount);
    const rate = parseRate(rateText);
    const request = {
        product_code: productCode,
        amount: amount === '' ? 0 : amount,
        term_months: term,
        rate: rate ?? undefined,
    };
    const debounced = useDebounced(request, 350);
    const settled = JSON.stringify(debounced) === JSON.stringify(request);
    const preview = useTermsPreview(app.id, amount === '' || rate === null ? null : debounced);

    const result = preview.data;
    const errors = (result?.errors ?? []).filter((error) => !isCommentHint(error));
    const limit = result?.limit !== null && result?.limit !== undefined ? num(result.limit) : null;
    const minRate = result?.min_rate !== null && result?.min_rate !== undefined ? num(result.min_rate) : null;
    const overLimit = limit !== null && amount !== '' && amount > limit;
    const needComment = overLimit && !errors.length && !comment.trim();
    const blocked =
        amount === '' || rate === null || !result || !settled || preview.isFetching || errors.length > 0 || needComment;

    const changeProduct = (code: string) => {
        const next = options.find((p) => p.code === code);
        if (!next) return;
        setProductCode(code);
        setAmount((value) =>
            clamp(value === '' ? num(next.min_amount) : value, num(next.min_amount), num(next.max_amount)),
        );
        setTerm((value) => clamp(value, next.min_term, next.max_term));
    };

    const submit = () => {
        if (blocked) return;
        decision.mutate(
            {
                id: app.id,
                action: 'COUNTER',
                product_code: productCode,
                amount,
                term_months: term,
                rate: rate ?? undefined,
                comment: comment.trim() || undefined,
            },
            { onSuccess: onDone },
        );
    };

    return (
        <div className='stack-16'>
            <Select
                label='Продукт'
                labelView='inner'
                size={56}
                block={true}
                options={options.map((p) => ({ key: p.code, content: p.name }))}
                selected={productCode}
                onChange={({ selected }) => selected && changeProduct(selected.key)}
            />
            <SliderInput
                label='Сумма, ₽'
                labelView='inner'
                size={56}
                block={true}
                value={amount === '' ? '' : amountFormat.format(amount)}
                sliderValue={amount === '' ? min : clamp(amount, min, max)}
                min={min}
                max={max}
                step={AMOUNT_STEP}
                pips={{ mode: 'values', values: [min, max], format: { to: (value: number) => shortAmount(value) } }}
                onChange={(_, { value }) => setAmount(value)}
            />
            <div className='bank-pair'>
                <Select
                    label='Срок'
                    labelView='inner'
                    size={56}
                    block={true}
                    options={termOptions(product, term).map((value) => ({
                        key: String(value),
                        content: months(value),
                    }))}
                    selected={String(term)}
                    onChange={({ selected }) => selected && setTerm(Number(selected.key))}
                />
                <Input
                    label='Ставка, %'
                    labelView='inner'
                    size={56}
                    block={true}
                    inputMode='decimal'
                    placeholder={minRate !== null ? `${minRate}`.replace('.', ',') : undefined}
                    value={rateText}
                    onChange={(_, { value }) => setRateText(value)}
                    error={rate === null ? 'Например, 21,5' : undefined}
                    hint={
                        rate === null
                            ? undefined
                            : minRate !== null
                              ? `не ниже ${percent(minRate)}`
                              : 'пусто — расчётная'
                    }
                />
            </div>
            <PreviewFigures preview={result} loading={preview.isFetching || !settled} />
            <ErrorPlate error={preview.error} title='Не удалось рассчитать условия' />
            <PreviewErrors errors={errors} />
            {overLimit && !errors.length && (
                <Plate view='attention' rounded={true} limitContentWidth={false} title='Сумма выше расчётного лимита'>
                    Превышение до 20{'\u00a0'}% допустимо — добавьте комментарий с обоснованием.
                </Plate>
            )}
            <Textarea
                label={overLimit ? 'Обоснование превышения лимита' : 'Комментарий (необязательно)'}
                labelView='inner'
                size={56}
                block={true}
                minRows={2}
                maxLength={2000}
                value={comment}
                onChange={(_, { value }) => setComment(value)}
            />
            <ErrorPlate error={decision.error} title='Решение не принято' />
            <Button
                view='primary'
                size={48}
                block={true}
                disabled={blocked}
                loading={decision.isPending}
                onClick={submit}
            >
                Предложить условия
            </Button>
        </div>
    );
}

function InfoForm({ data, onDone }: { data: Dossier; onDone: () => void }) {
    const app = data.application;
    const request = useRequestInfo();
    const [items, setItems] = useState<string[]>([]);
    const [comment, setComment] = useState('');
    const [due, setDue] = useState(72);
    const recommended = useMemo(() => {
        const result = new Map<string, string>();
        (data.auto_decision?.flags ?? []).forEach((flag) =>
            (FLAG_INFO_ITEMS[flag.code] ?? []).forEach((code) => {
                if (!result.has(code)) result.set(code, flag.code);
            }),
        );
        return result;
    }, [data.auto_decision]);
    const needComment = items.includes('OTHER') && !comment.trim();

    const toggle = (code: string, checked: boolean) =>
        setItems((current) => (checked ? [...current, code] : current.filter((item) => item !== code)));

    const submit = () =>
        request.mutate({ id: app.id, items, comment: comment.trim(), due_hours: due }, { onSuccess: onDone });

    return (
        <div className='stack-16'>
            <div className='bank-checklist'>
                {data.info_item_presets.map((preset) => (
                    <Checkbox
                        key={preset.code}
                        size={24}
                        block={true}
                        checked={items.includes(preset.code)}
                        onChange={(_, { checked }) => toggle(preset.code, checked)}
                        label={
                            <span>
                                {preset.title}
                                {recommended.has(preset.code) && (
                                    <span className='bank-tag'>{recommended.get(preset.code)}</span>
                                )}
                            </span>
                        }
                        hint={preset.hint}
                    />
                ))}
            </div>
            <Textarea
                label='Комментарий для клиента'
                labelView='inner'
                size={56}
                block={true}
                minRows={2}
                maxLength={2000}
                value={comment}
                onChange={(_, { value }) => setComment(value)}
                hint={needComment ? 'Опишите, что нужно: клиент увидит этот текст' : undefined}
            />
            <div className='stack-8'>
                <div className='bank-caption'>Срок ответа</div>
                <div className='chips'>
                    {DUE_OPTIONS.map((hours) => (
                        <button
                            key={hours}
                            type='button'
                            className={`chip${due === hours ? ' chip--active' : ''}`}
                            aria-pressed={due === hours}
                            onClick={() => setDue(hours)}
                        >
                            {hours} ч
                        </button>
                    ))}
                </div>
                <div className='bank-sub'>
                    Если клиент не ответит вовремя, заявка закроется со статусом «Истёк срок».
                </div>
            </div>
            <ErrorPlate error={request.error} title='Запрос не отправлен' />
            <Button
                view='primary'
                size={48}
                block={true}
                disabled={!items.length || needComment}
                loading={request.isPending}
                onClick={submit}
            >
                Отправить запрос
            </Button>
        </div>
    );
}

function RejectForm({ app, meta, onDone }: { app: Application; meta: Meta | undefined; onDone: () => void }) {
    const decision = useDecision();
    const [reason, setReason] = useState<string | null>(null);
    const [comment, setComment] = useState('');
    const codes = Object.keys(meta?.reasons ?? {}).sort();
    const clientText = reason
        ? reason === 'R07'
            ? comment.trim() || 'текст вашего комментария'
            : meta?.reasons[reason]?.client
        : null;

    const submit = () => {
        if (!reason || !comment.trim()) return;
        decision.mutate(
            { id: app.id, action: 'REJECT', reason_code: reason, comment: comment.trim() },
            { onSuccess: onDone },
        );
    };

    return (
        <div className='stack-16'>
            <Select
                label='Причина отказа'
                labelView='inner'
                size={56}
                block={true}
                options={codes.map((code) => ({ key: code, content: `${code} · ${meta?.reasons[code]?.bank ?? ''}` }))}
                selected={reason}
                onChange={({ selected }) => setReason(selected?.key ?? null)}
            />
            <Textarea
                label='Комментарий, обязательно'
                labelView='inner'
                size={56}
                block={true}
                minRows={3}
                maxLength={2000}
                value={comment}
                onChange={(_, { value }) => setComment(value)}
            />
            {clientText && (
                <div className='tile stack-8'>
                    <div className='bank-caption'>Клиент увидит причину</div>
                    <div>«{clientText}»</div>
                </div>
            )}
            <ErrorPlate error={decision.error} title='Решение не принято' />
            <Button
                view='primary'
                size={48}
                block={true}
                disabled={!reason || !comment.trim()}
                loading={decision.isPending}
                onClick={submit}
            >
                Отказать
            </Button>
        </div>
    );
}

function ReviewPanel({ data, meta }: { data: Dossier; meta: Meta | undefined }) {
    const app = data.application;
    const [action, setAction] = useState<Action | null>(null);
    const restart = useRestart();
    const sourceDown = (data.auto_decision?.flags ?? []).some((flag) => flag.code === 'F05');
    const limit = data.limit?.limit ?? null;
    const done = () => setAction(null);

    return (
        <section className='card card--tight stack-16' aria-label='Решение по заявке'>
            <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                Решение по заявке
            </Typography.Title>
            {action === null ? (
                <div className='tile'>
                    <KeyValue
                        items={[
                            ['Запрошено', `${rub(app.amount)} на ${months(app.term_months)}`],
                            ['Продукт', app.product.name],
                            [
                                'Класс риска',
                                <RiskBadge
                                    key='risk'
                                    riskClass={data.scoring?.risk_class}
                                    score={data.scoring?.score}
                                />,
                            ],
                            ['Расчётный лимит', limit !== null ? rub(limit) : 'не рассчитан'],
                            ['Расчётная ставка', data.limit ? `${percent(data.limit.rate)} годовых` : '—'],
                        ]}
                    />
                </div>
            ) : (
                <div className='bank-sub'>
                    Запрошено {rub(app.amount)} на {months(app.term_months)} · {app.product.name}
                    {data.scoring ? ` · класс ${data.scoring.risk_class}` : ''}
                    {limit !== null ? ` · лимит ${rub(limit)}` : ''}
                </div>
            )}
            <div className='bank-actions' role='group' aria-label='Действие'>
                {ACTIONS.map((item) => (
                    <button
                        key={item.key}
                        type='button'
                        className={`chip${action === item.key ? ' chip--active' : ''}`}
                        aria-pressed={action === item.key}
                        onClick={() => setAction(item.key)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
            {action === null && (
                <div className='bank-sub'>
                    Выберите решение. Клиент увидит результат в кабинете сразу после отправки.
                </div>
            )}
            {action === 'APPROVE' && <ApproveForm app={app} onDone={done} onCounter={() => setAction('COUNTER')} />}
            {action === 'COUNTER' && <CounterForm data={data} onDone={done} />}
            {action === 'INFO' && <InfoForm data={data} onDone={done} />}
            {action === 'REJECT' && <RejectForm app={app} meta={meta} onDone={done} />}
            {sourceDown && (
                <div className='stack-8'>
                    <Plate
                        view='attention'
                        rounded={true}
                        limitContentWidth={false}
                        title='Внешний источник был недоступен'
                    >
                        Когда источник восстановится, перезапустите проверку: конвейер заново запросит данные и
                        пересчитает решение.
                    </Plate>
                    <Button
                        view='secondary'
                        size={40}
                        block={true}
                        loading={restart.isPending}
                        onClick={() => restart.mutate(app.id)}
                    >
                        Перезапустить автоматическую проверку
                    </Button>
                    <ErrorPlate error={restart.error} title='Не удалось перезапустить' />
                </div>
            )}
        </section>
    );
}

function OfferList({ offers }: { offers: Offer[] }) {
    return (
        <div className='stack-8'>
            {offers.map((offer) => (
                <div key={offer.id} className='tile stack-8'>
                    <div className='bank-strong'>{offer.product_name}</div>
                    <div>
                        {rub(offer.amount)} · {months(offer.term_months)} · {percent(offer.rate)}
                    </div>
                    <div className='bank-sub'>
                        {offer.payment_label}: {rub(offer.monthly_payment)}
                        {offer.note ? ` · ${offer.note}` : ''}
                    </div>
                </div>
            ))}
        </div>
    );
}

function StateCard({ data, meta }: { data: Dossier; meta: Meta | undefined }) {
    const app = data.application;
    const retry = useRetryNow();
    useNow(30_000);
    const last = data.last_decision;
    const openRequest = app.info_requests.find((request) => request.status === 'OPEN');
    const waiting = app.steps.find((step) => step.status === 'WAITING');
    const running = app.steps.find((step) => step.status === 'RUNNING');
    const activeOffers = app.offers.filter((offer) => offer.status === 'ACTIVE');
    const accepted = app.offers.filter((offer) => offer.status === 'ACCEPTED');

    let title: string;
    let body: ReactNode = null;
    switch (app.status) {
        case 'SUBMITTED':
        case 'IN_PROCESSING':
            title = waiting ? `Ждём ответ: ${waiting.title}` : 'Идёт автоматическая проверка';
            body = waiting ? (
                <>
                    <div className='bank-sub'>
                        {waiting.error ?? waiting.waiting_text}. Попыток: {waiting.attempts}.
                        {waiting.next_retry_at ? ` Следующая попытка в ${time(waiting.next_retry_at)}.` : ''}
                    </div>
                    <Button
                        view='secondary'
                        size={40}
                        block={true}
                        loading={retry.isPending}
                        onClick={() => retry.mutate(app.id)}
                    >
                        Повторить сейчас
                    </Button>
                    <ErrorPlate error={retry.error} title='Не удалось повторить' />
                </>
            ) : (
                <div className='bank-sub'>
                    {running?.waiting_text ?? 'Конвейер собирает данные'}. Система примет решение сама или передаст
                    заявку аналитику.
                </div>
            );
            break;
        case 'NEED_INFO':
            title = openRequest ? `Ждём ответ клиента до ${dateTime(openRequest.due_at)}` : 'Ждём ответ клиента';
            body = openRequest && (
                <>
                    <div className={new Date(openRequest.due_at).getTime() < Date.now() ? 'bank-overdue' : 'bank-sub'}>
                        {timeLeft(openRequest.due_at)}
                    </div>
                    <ul className='bank-list'>
                        {openRequest.items.map((item) => (
                            <li key={item.code}>{item.title}</li>
                        ))}
                    </ul>
                    {openRequest.comment && <div className='bank-quote'>{openRequest.comment}</div>}
                </>
            );
            break;
        case 'OFFER':
            title = activeOffers.length
                ? `Предложение у клиента до ${dateTime(activeOffers[0].valid_until)}`
                : 'Предложение у клиента';
            body = activeOffers.length > 0 && <OfferList offers={activeOffers} />;
            break;
        case 'ACCEPTED':
            title = 'Клиент принял условия';
            body = (
                <>
                    {accepted.length > 0 && <OfferList offers={accepted} />}
                    <div className='bank-sub'>Готовим договор — он появится во вкладке «Документы».</div>
                </>
            );
            break;
        case 'SIGNING':
            title = 'Ждём подписания договора';
            body = accepted.length > 0 && <OfferList offers={accepted} />;
            break;
        case 'SIGNED':
            title = 'Договор подписан';
            body = <div className='bank-sub'>Перечисляем деньги на счёт клиента.</div>;
            break;
        case 'ISSUED':
            title = 'Кредит выдан';
            body = app.loan && (
                <div className='tile'>
                    <KeyValue
                        items={[
                            ['Сумма', rub(app.loan.amount)],
                            ['Ставка', `${percent(app.loan.rate)} годовых`],
                            ['Срок', months(app.loan.term_months)],
                            ['Платёж в месяц', rub(app.loan.monthly_payment)],
                            ['Счёт', app.loan.account_number],
                            ['Выдан', dateTime(app.loan.issued_at)],
                        ]}
                    />
                </div>
            );
            break;
        case 'REJECTED':
            title = 'Заявка отклонена';
            body = app.explanation.rejection.length > 0 && (
                <div className='tile stack-8'>
                    <div className='bank-caption'>Клиент видит</div>
                    <ul className='bank-list'>
                        {app.explanation.rejection.map((line) => (
                            <li key={line}>{line}</li>
                        ))}
                    </ul>
                </div>
            );
            break;
        case 'DECLINED':
            title = 'Клиент отказался от предложения';
            break;
        case 'CANCELLED':
            title = 'Клиент отозвал заявку';
            break;
        case 'EXPIRED':
            title = 'Срок истёк';
            body = <div className='bank-sub'>Клиент не ответил вовремя — заявка закрыта.</div>;
            break;
        default:
            title = app.status_label;
    }

    const showDecision = last && ['APPROVE', 'COUNTER', 'REJECT'].includes(last.outcome);
    return (
        <section className='card card--tight stack-16' aria-label='Состояние заявки'>
            <div className='row row--between'>
                <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                    Состояние
                </Typography.Title>
                <StatusBadge status={app.status} label={app.status_label} />
            </div>
            <Typography.Text view='primary-large' weight='bold' tag='div'>
                {title}
            </Typography.Text>
            {body}
            {showDecision && last && (
                <div className='tile stack-8'>
                    <div className='bank-caption'>Решение принято</div>
                    <div className='bank-strong'>
                        {OUTCOME_LABELS[last.outcome] ?? last.outcome}
                        {last.limit !== null && last.outcome !== 'REJECT' ? ` · лимит ${rub(last.limit)}` : ''}
                    </div>
                    <div className='bank-sub'>
                        {last.kind === 'AUTO' ? 'Автоматически' : (last.decided_by ?? 'Аналитик')} ·{' '}
                        {dateTime(last.created_at)}
                    </div>
                    {last.reason_codes.length > 0 && (
                        <div className='bank-sub'>
                            Причина:{' '}
                            {last.reason_codes
                                .map((code) => `${code} ${meta?.reasons[code]?.bank ?? ''}`.trim())
                                .join(', ')}
                        </div>
                    )}
                    {last.comment && <div className='bank-quote'>{last.comment}</div>}
                </div>
            )}
            {(app.status === 'SUBMITTED' || app.status === 'IN_PROCESSING' || app.status === 'NEED_INFO') && (
                <div className='bank-sub'>
                    Решение можно будет принять, когда заявка вернётся на ручное рассмотрение.
                </div>
            )}
        </section>
    );
}

export function DecisionPanel({ data, meta }: { data: Dossier; meta: Meta | undefined }) {
    if (data.application.status === 'MANUAL_REVIEW') {
        return (
            <ReviewPanel key={`${data.application.id}:${data.application.status_changed_at}`} data={data} meta={meta} />
        );
    }
    return <StateCard data={data} meta={meta} />;
}
