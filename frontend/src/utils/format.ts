import type { AppStatus, Money } from '../api/types';

const rubFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

export const num = (value: Money | null | undefined): number =>
    value === null || value === undefined ? 0 : Number(value);

// Неразрывный пробел (\u00a0) перед знаком: на узком экране «₽» и «%» не отрываются от числа
export const rub = (value: Money | null | undefined): string => `${rubFormat.format(Math.round(num(value)))}\u00a0₽`;

export const plainNumber = (value: Money | null | undefined): string => numberFormat.format(num(value));

export const percent = (value: Money | null | undefined): string => `${numberFormat.format(num(value))}\u00a0%`;

export function plural(n: number, one: string, few: string, many: string): string {
    const abs = Math.abs(n);
    if (abs % 10 === 1 && abs % 100 !== 11) return one;
    if (abs % 10 >= 2 && abs % 10 <= 4 && (abs % 100 < 12 || abs % 100 > 14)) return few;
    return many;
}

export function months(n: number): string {
    const years = Math.floor(n / 12);
    const rest = n % 12;
    const parts: string[] = [];
    if (years) parts.push(`${years}\u00a0${plural(years, 'год', 'года', 'лет')}`);
    if (rest || !years) parts.push(`${rest}\u00a0мес.`);
    return parts.join(' ');
}

export function shortAmount(value: number): string {
    if (value >= 1_000_000) return `${numberFormat.format(value / 1_000_000)}\u00a0млн\u00a0₽`;
    if (value >= 1_000) return `${numberFormat.format(value / 1_000)}\u00a0тыс.\u00a0₽`;
    return `${value}\u00a0₽`;
}

export const date = (iso: string | null | undefined): string =>
    iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

export const dateTime = (iso: string | null | undefined): string =>
    iso
        ? new Date(iso).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
          })
        : '—';

export const time = (iso: string | null | undefined): string =>
    iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';

export function timeLeft(iso: string | null | undefined): string {
    if (!iso) return '';
    const diff = new Date(iso).getTime() - Date.now();
    const abs = Math.abs(diff);
    const hours = Math.floor(abs / 3_600_000);
    const minutes = Math.floor((abs % 3_600_000) / 60_000);
    const text =
        hours >= 24
            ? `${Math.floor(hours / 24)} дн. ${hours % 24} ч`
            : hours
              ? `${hours} ч ${minutes} мин`
              : `${minutes} мин`;
    return diff >= 0 ? `осталось ${text}` : `просрочено на ${text}`;
}

export const fileSize = (bytes: number): string =>
    bytes >= 1_048_576 ? `${numberFormat.format(bytes / 1_048_576)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;

export type StatusColor = 'green' | 'orange' | 'red' | 'blue' | 'grey' | 'teal' | 'purple';

export const STATUS_COLORS: Record<AppStatus, StatusColor> = {
    DRAFT: 'grey',
    SUBMITTED: 'blue',
    IN_PROCESSING: 'blue',
    NEED_INFO: 'orange',
    MANUAL_REVIEW: 'purple',
    OFFER: 'green',
    ACCEPTED: 'teal',
    SIGNING: 'orange',
    SIGNED: 'teal',
    ISSUED: 'green',
    REJECTED: 'red',
    DECLINED: 'grey',
    CANCELLED: 'grey',
    EXPIRED: 'grey',
};

export const RISK_COLORS: Record<string, StatusColor> = { A: 'green', B: 'teal', C: 'orange', D: 'red', E: 'red' };

export const legalFormLabel = (form: string | null | undefined): string =>
    form === 'IP'
        ? 'Индивидуальный предприниматель'
        : form === 'OOO'
          ? 'Общество с ограниченной ответственностью'
          : '—';
