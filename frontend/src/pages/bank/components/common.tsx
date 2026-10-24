import { CheckmarkCircleMIcon } from '@alfalab/icons-glyph/CheckmarkCircleMIcon';
import { CrossCircleMIcon } from '@alfalab/icons-glyph/CrossCircleMIcon';
import { type ReactNode, useEffect, useState } from 'react';

import type { Meta, Priority, Step } from '../../../api/types';
import { Badge, SectionTitle } from '../../../components/ui';
import { RISK_COLORS, type StatusColor } from '../../../utils/format';

export const CONSTRAINT_LABELS: Record<string, string> = {
    PRODUCT_MAX: 'Максимум продукта',
    REVENUE: 'По выручке',
    COLLATERAL: 'По залогу (80\u00a0%)',
    DSCR: 'По платёжеспособности (DSCR ≥ 1,3)',
    OVERDRAFT: '40\u00a0% поступлений на счёт',
};

export const OUTCOME_LABELS: Record<string, string> = {
    APPROVE: 'Одобрено',
    COUNTER: 'Контрпредложение',
    REJECT: 'Отказ',
    NEED_INFO: 'Запрошена информация',
    MANUAL_REVIEW: 'Передано аналитику',
};

export const OUTCOME_COLORS: Record<string, StatusColor> = {
    APPROVE: 'green',
    COUNTER: 'teal',
    REJECT: 'red',
    NEED_INFO: 'orange',
    MANUAL_REVIEW: 'purple',
};

export const ACTOR_LABELS: Record<string, string> = {
    CLIENT: 'Клиент',
    SYSTEM: 'Система',
    UNDERWRITER: 'Аналитик',
    ADMIN: 'Администратор',
};

export const SOURCE_STATE: Record<Step['status'], { label: string; color: StatusColor }> = {
    DONE: { label: 'Получено', color: 'green' },
    SKIPPED: { label: 'Не требуется', color: 'grey' },
    RUNNING: { label: 'Запрашиваем', color: 'blue' },
    WAITING: { label: 'Ждём ответ', color: 'orange' },
    FAILED: { label: 'Недоступен', color: 'red' },
    PENDING: { label: 'В очереди', color: 'grey' },
};

export const FLAG_HINTS: Record<string, string> = {
    F01: 'Запросите документ о праве пользования офисом',
    F02: 'Запросите пояснение, когда и как будет погашен долг',
    F03: 'Уточните причину смены руководителя',
    F04: 'Сверьте выручку с отчётностью или выпиской по счёту',
    F05: 'Когда источник восстановится, перезапустите автоматическую проверку',
    F06: 'Проверьте текущую просрочку в кредитной истории',
    F07: 'Повышенный риск — оцените финансовое положение подробнее',
};

// Какие пункты запроса информации помогают снять флаг
export const FLAG_INFO_ITEMS: Record<string, string[]> = {
    F01: ['ADDRESS_CONFIRMATION'],
    F02: ['TAX_EXPLANATION'],
    F04: ['FIN_STATEMENT', 'BANK_STATEMENT'],
};

export const FAULT_SOURCE_TITLES: Record<string, string> = {
    egrul: 'ЕГРЮЛ / ЕГРИП',
    fns: 'ФНС «Прозрачный бизнес»',
    girbo: 'ГИР БО (отчётность)',
    bki: 'Бюро кредитных историй',
    bank: 'Внутренние данные банка',
    core: 'Выдача кредита (АБС)',
};

export const FAULT_MODES: Record<'ok' | 'error' | 'timeout' | 'slow', { label: string; color: StatusColor }> = {
    ok: { label: 'Работает', color: 'green' },
    error: { label: 'Ошибка', color: 'red' },
    timeout: { label: 'Таймаут', color: 'orange' },
    slow: { label: 'Медленно', color: 'blue' },
};

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function monthLabel(value: string): string {
    const [year, month] = value.split('-');
    return `${MONTHS[Number(month) - 1] ?? month} ${(year ?? '').slice(2)}`;
}

const compactFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const compactFormatShort = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

export function compactRub(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 10_000_000) return `${compactFormatShort.format(value / 1_000_000)} млн`;
    if (abs >= 1_000_000) return `${compactFormat.format(value / 1_000_000)} млн`;
    if (abs >= 1_000) return `${compactFormat.format(Math.round(value / 1_000))} тыс`;
    return compactFormat.format(value);
}

export const decimal = (value: number, digits = 2): string =>
    value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const signed = (value: number): string => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0');

export const shortId = (id: string): string => id.slice(0, 8);

/** «Иванова Ольга Дмитриевна» → «Иванова О. Д.» */
export function shortName(fullName: string): string {
    const [last, ...rest] = fullName.trim().split(/\s+/);
    if (!rest.length) return fullName;
    return `${last} ${rest.map((part) => `${part[0]}.`).join(' ')}`;
}

/** Текущее время, обновляется по таймеру: нужно для обратных отсчётов и «осталось N мин». */
export function useNow(intervalMs = 30_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}

/** Значение с задержкой: живой расчёт не дёргает сервер на каждое нажатие клавиши. */
export function useDebounced<T>(value: T, delay = 300): T {
    const [debounced, setDebounced] = useState(value);
    const serialized = JSON.stringify(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(JSON.parse(serialized) as T), delay);
        return () => clearTimeout(timer);
    }, [serialized, delay]);
    return debounced;
}

/** «через 12 с», «3 мин назад» — относительно переданного момента. */
export function relative(iso: string | null | undefined, now: number): string {
    if (!iso) return '—';
    const diff = Math.round((new Date(iso).getTime() - now) / 1000);
    const abs = Math.abs(diff);
    if (abs < 2) return 'сейчас';
    let text = `${abs} с`;
    if (abs >= 3600) text = `${Math.floor(abs / 3600)} ч ${Math.floor((abs % 3600) / 60)} мин`;
    else if (abs >= 60) text = `${Math.floor(abs / 60)} мин`;
    return diff > 0 ? `через ${text}` : `${text} назад`;
}

export function RiskBadge({ riskClass, score }: { riskClass: string | null | undefined; score?: number | null }) {
    if (!riskClass) return <span className='muted'>—</span>;
    return (
        <Badge color={RISK_COLORS[riskClass] ?? 'grey'}>
            {score === null || score === undefined ? riskClass : `${riskClass} · ${score}`}
        </Badge>
    );
}

export const PRIORITY_LABELS: Record<Priority, { label: string; color: StatusColor }> = {
    HIGH: { label: 'Высокий', color: 'red' },
    MEDIUM: { label: 'Средний', color: 'orange' },
    NORMAL: { label: 'Обычный', color: 'grey' },
};

/** Приоритет заявки на ручном рассмотрении; причины, если переданы, — во всплывающей подсказке. */
export function PriorityBadge({ priority, reasons = [] }: { priority: Priority | null; reasons?: string[] }) {
    if (!priority) return <span className='muted'>—</span>;
    const { label, color } = PRIORITY_LABELS[priority];
    return (
        <span title={reasons.length ? reasons.join('\n') : undefined}>
            <Badge color={color}>{label}</Badge>
        </span>
    );
}

export function FlagBadges({ codes, meta }: { codes: string[]; meta: Meta | undefined }) {
    if (!codes.length) return <span className='muted'>—</span>;
    return (
        <span className='bank-flags'>
            {codes.map((code) => (
                <span key={code} title={meta?.flags[code] ?? code}>
                    <Badge color={code === 'F05' ? 'red' : 'orange'}>{code}</Badge>
                </span>
            ))}
        </span>
    );
}

export function Card({ title, extra, children }: { title?: ReactNode; extra?: ReactNode; children: ReactNode }) {
    return (
        <section className='card card--tight'>
            {title && <SectionTitle extra={extra}>{title}</SectionTitle>}
            {children}
        </section>
    );
}

export function Sub({ children }: { children: ReactNode }) {
    return <div className='bank-sub'>{children}</div>;
}

/** Строка проверки: зелёная галочка — хорошо, красный крестик — повод присмотреться. */
export function Check({
    ok,
    label,
    value,
    stacked = false,
}: {
    ok: boolean | null;
    label: ReactNode;
    value?: ReactNode;
    stacked?: boolean;
}) {
    const tone = ok === null ? '' : ok ? ' bank-check--ok' : ' bank-check--bad';
    return (
        <li className={`bank-check${tone}`}>
            {ok === null ? (
                <span className='bank-check__dot' aria-hidden={true} />
            ) : ok ? (
                <CheckmarkCircleMIcon width={20} height={20} role='img' aria-label='Норма' />
            ) : (
                <CrossCircleMIcon width={20} height={20} role='img' aria-label='Требует внимания' />
            )}
            {stacked ? (
                <span className='bank-check__body'>
                    <span className='bank-check__label'>{label}</span>
                    <span className='bank-check__strong'>{value}</span>
                </span>
            ) : (
                <>
                    <span>{label}</span>
                    {value !== undefined && <span className='bank-check__value'>{value}</span>}
                </>
            )}
        </li>
    );
}

// Как у .sticky в global.css: высота шапки 64 + отступ 24
const STICKY_TOP = 88;
const STICKY_GAP = 24;

/**
 * Липкая правая колонка: если панель выше окна, она прокручивается вместе со страницей,
 * пока не покажется её низ с кнопкой решения, и только потом «прилипает».
 */
export function useStickyTop(): [(element: HTMLElement | null) => void, number | undefined] {
    const [element, setElement] = useState<HTMLElement | null>(null);
    const [top, setTop] = useState<number | undefined>();
    useEffect(() => {
        if (!element) return undefined;
        const update = () => setTop(Math.min(STICKY_TOP, window.innerHeight - element.offsetHeight - STICKY_GAP));
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        window.addEventListener('resize', update);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', update);
        };
    }, [element]);
    return [setElement, top];
}
