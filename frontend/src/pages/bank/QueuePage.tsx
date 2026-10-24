import { Checkbox } from '@alfalab/core-components/checkbox';
import { Input } from '@alfalab/core-components/input';
import { Select } from '@alfalab/core-components/select';
import { CrossSIcon } from '@alfalab/icons-glyph/CrossSIcon';
import { MagnifierMIcon } from '@alfalab/icons-glyph/MagnifierMIcon';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { type QueueFilters, useBankSummary, useMeta, useProducts, useQueue } from '../../api/hooks';
import type { AppStatus, BankSummary, QueueItem } from '../../api/types';
import { Badge, Empty, ErrorPlate, Loader, PageHead, StatusBadge } from '../../components/ui';
import { date, months, rub, timeLeft } from '../../utils/format';
import { FlagBadges, RiskBadge, shortName, useNow } from './components/common';
import './bank.css';

type Group = 'active' | 'review' | 'need_info' | 'auto' | 'offers' | 'closed';
type Extra = 'overdue' | 'waiting' | 'offer' | 'issued_today';

const GROUPS: { key: Group; label: string; statuses?: AppStatus[]; closed?: boolean }[] = [
    { key: 'active', label: 'Все активные' },
    { key: 'review', label: 'На рассмотрении', statuses: ['MANUAL_REVIEW'] },
    { key: 'need_info', label: 'Ждут клиента', statuses: ['NEED_INFO'] },
    { key: 'auto', label: 'Автопроверка', statuses: ['SUBMITTED', 'IN_PROCESSING'] },
    { key: 'offers', label: 'Предложения', statuses: ['OFFER', 'ACCEPTED', 'SIGNING', 'SIGNED'] },
    {
        key: 'closed',
        label: 'Завершённые',
        statuses: ['ISSUED', 'REJECTED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
        closed: true,
    },
];

const startOfUtcDay = (): number => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

// Уточнения поверх группы статусов: так плитки сводки показывают ровно те заявки, что посчитаны
const EXTRAS: Record<Extra, { label: string; test: (row: QueueItem) => boolean }> = {
    overdue: { label: 'Просроченные', test: (row) => row.overdue },
    waiting: { label: 'Ждут внешний источник', test: (row) => Boolean(row.waiting_source) },
    offer: { label: 'Предложение у клиента', test: (row) => row.status === 'OFFER' },
    issued_today: {
        label: 'Выданы сегодня',
        test: (row) => row.status === 'ISSUED' && new Date(row.status_changed_at).getTime() >= startOfUtcDay(),
    },
};

interface Tile {
    key: keyof BankSummary;
    label: string;
    group: Group;
    mine?: boolean;
    extra?: Extra;
    tone?: 'negative' | 'attention';
}

const TILES: Tile[] = [
    { key: 'manual_review', label: 'На рассмотрении', group: 'review' },
    { key: 'mine', label: 'Мои в работе', group: 'review', mine: true },
    { key: 'overdue', label: 'Просрочено', group: 'review', extra: 'overdue', tone: 'negative' },
    { key: 'need_info', label: 'Ждут клиента', group: 'need_info' },
    { key: 'in_processing', label: 'Автопроверка', group: 'auto' },
    { key: 'waiting_sources', label: 'Ждут внешний источник', group: 'auto', extra: 'waiting', tone: 'attention' },
    { key: 'offers', label: 'Предложения у клиентов', group: 'offers', extra: 'offer' },
    { key: 'issued_today', label: 'Выдано сегодня', group: 'closed', extra: 'issued_today' },
];

const ALL_PRODUCTS = 'ALL';

export function QueuePage() {
    const navigate = useNavigate();
    const summary = useBankSummary();
    const meta = useMeta();
    const products = useProducts();
    const [group, setGroup] = useState<Group>('active');
    const [extra, setExtra] = useState<Extra | null>(null);
    const [mine, setMine] = useState(false);
    const [product, setProduct] = useState(ALL_PRODUCTS);
    const [search, setSearch] = useState('');
    const [q, setQ] = useState('');
    useNow(30_000);

    useEffect(() => {
        const timer = setTimeout(() => setQ(search.trim()), 300);
        return () => clearTimeout(timer);
    }, [search]);

    const filters = useMemo<QueueFilters>(() => {
        const definition = GROUPS.find((item) => item.key === group);
        return {
            status: definition?.statuses,
            include_closed: definition?.closed,
            mine: mine || undefined,
            q: q || undefined,
            product: product === ALL_PRODUCTS ? undefined : product,
        };
    }, [group, mine, q, product]);

    const queue = useQueue(filters);
    const rows = useMemo(
        () => (queue.data ?? []).filter((row) => (extra ? EXTRAS[extra].test(row) : true)),
        [queue.data, extra],
    );

    const applyTile = (tile: Tile) => {
        setGroup(tile.group);
        setMine(Boolean(tile.mine));
        setExtra(tile.extra ?? null);
    };

    const chooseGroup = (next: Group) => {
        setGroup(next);
        setExtra(null);
    };

    const open = (id: string) => navigate(`/bank/applications/${id}`);
    const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open(id);
        }
    };

    const filtered = group !== 'active' || extra !== null || mine || Boolean(q) || product !== ALL_PRODUCTS;

    return (
        <div className='page page--wide bank-page'>
            <PageHead
                title='Очередь заявок'
                subtitle='Ручное рассмотрение, ожидание клиента и автоматическая проверка. Данные обновляются сами.'
            />

            <div className='bank-tiles' role='group' aria-label='Сводка по заявкам'>
                {TILES.map((tile) => {
                    const value = summary.data?.[tile.key];
                    const active =
                        group === tile.group && mine === Boolean(tile.mine) && extra === (tile.extra ?? null);
                    const tone = tile.tone && value ? ` bank-tile__value--${tile.tone}` : '';
                    return (
                        <button
                            key={tile.key}
                            type='button'
                            className={`bank-tile${active ? ' bank-tile--active' : ''}`}
                            aria-pressed={active}
                            onClick={() => applyTile(tile)}
                        >
                            <span className='bank-tile__label'>{tile.label}</span>
                            <span className={`bank-tile__value${tone}`}>{value ?? '—'}</span>
                        </button>
                    );
                })}
            </div>

            <section className='card card--tight'>
                <div className='bank-filters'>
                    <div className='chips' role='group' aria-label='Статус заявки'>
                        {GROUPS.map((item) => (
                            <button
                                key={item.key}
                                type='button'
                                className={`chip${group === item.key ? ' chip--active' : ''}`}
                                aria-pressed={group === item.key}
                                onClick={() => chooseGroup(item.key)}
                            >
                                {item.label}
                            </button>
                        ))}
                        {extra && (
                            <button
                                type='button'
                                className='chip chip--active bank-chip-extra'
                                title='Снять уточнение'
                                aria-label={`Снять уточнение «${EXTRAS[extra].label}»`}
                                onClick={() => setExtra(null)}
                            >
                                {EXTRAS[extra].label}
                                <CrossSIcon width={16} height={16} aria-hidden={true} />
                            </button>
                        )}
                    </div>
                    <div className='bank-filters__controls'>
                        <div className='bank-search'>
                            <Input
                                placeholder='Компания, ИНН или номер'
                                size={48}
                                block={true}
                                leftAddons={
                                    <MagnifierMIcon
                                        width={20}
                                        height={20}
                                        className='bank-search__icon'
                                        aria-hidden={true}
                                    />
                                }
                                clear={true}
                                value={search}
                                onChange={(_, { value }) => setSearch(value)}
                                onClear={() => setSearch('')}
                                aria-label='Поиск по компании, ИНН или номеру заявки'
                            />
                        </div>
                        <div className='bank-product'>
                            <Select
                                label='Продукт'
                                size={48}
                                block={true}
                                options={[
                                    { key: ALL_PRODUCTS, content: 'Все продукты' },
                                    ...(products.data ?? []).map((p) => ({ key: p.code, content: p.name })),
                                ]}
                                selected={product}
                                onChange={({ selected }) => setProduct(selected?.key ?? ALL_PRODUCTS)}
                            />
                        </div>
                        <Checkbox
                            checked={mine}
                            onChange={(_, { checked }) => setMine(checked)}
                            label='Только мои'
                            size={24}
                        />
                    </div>
                </div>

                <ErrorPlate error={queue.error} title='Не удалось загрузить очередь' />
                {queue.isLoading && <Loader />}
                {queue.data && !rows.length && (
                    <Empty
                        title='Заявок нет'
                        text={
                            filtered
                                ? 'Измените фильтры или сбросьте поиск'
                                : 'Новые заявки появятся здесь автоматически'
                        }
                    />
                )}
                {rows.length > 0 && (
                    <>
                        <div className='bank-count'>Показано заявок: {rows.length}</div>
                        <div className={`table-wrap${queue.isPlaceholderData ? ' bank-dim' : ''}`}>
                            <table className='simple bank-queue'>
                                <thead>
                                    <tr>
                                        <th>№ заявки</th>
                                        <th>Компания</th>
                                        <th>Продукт</th>
                                        <th className='num'>Сумма</th>
                                        <th>Срок</th>
                                        <th>Статус</th>
                                        <th>Риск</th>
                                        <th>Флаги</th>
                                        <th>Срок обработки</th>
                                        <th>Исполнитель</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((row) => (
                                        <tr
                                            key={row.id}
                                            className='clickable'
                                            tabIndex={0}
                                            onClick={() => open(row.id)}
                                            onKeyDown={(event) => onRowKey(event, row.id)}
                                        >
                                            <td>
                                                <div className='bank-strong bank-nowrap'>{row.number}</div>
                                                <div className='bank-sub'>{date(row.submitted_at)}</div>
                                            </td>
                                            <td>
                                                <div className='bank-strong'>{row.company_name}</div>
                                                <div className='bank-sub'>ИНН {row.inn}</div>
                                            </td>
                                            <td className='bank-product-cell'>{row.product_name}</td>
                                            <td className='num'>{rub(row.amount)}</td>
                                            <td className='bank-nowrap'>{months(row.term_months)}</td>
                                            <td>
                                                <div className='bank-status-cell'>
                                                    <StatusBadge
                                                        status={row.status}
                                                        label={row.status_label}
                                                        size={20}
                                                    />
                                                    {row.waiting_source && (
                                                        <Badge color='orange'>Ждём: {row.waiting_source}</Badge>
                                                    )}
                                                </div>
                                            </td>
                                            <td className='bank-nowrap'>
                                                <RiskBadge riskClass={row.risk_class} score={row.score} />
                                            </td>
                                            <td>
                                                <FlagBadges codes={row.flags} meta={meta.data} />
                                            </td>
                                            <td className='bank-nowrap'>
                                                {row.sla_due_at ? (
                                                    <span className={row.overdue ? 'bank-overdue' : undefined}>
                                                        {timeLeft(row.sla_due_at)}
                                                    </span>
                                                ) : (
                                                    <span className='muted'>—</span>
                                                )}
                                            </td>
                                            <td>
                                                {row.assignee_name ? (
                                                    <span className='bank-nowrap' title={row.assignee_name}>
                                                        {shortName(row.assignee_name)}
                                                        {row.assignee_is_me && <span className='bank-sub'> · вы</span>}
                                                    </span>
                                                ) : (
                                                    <span className='muted'>—</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </section>
        </div>
    );
}
