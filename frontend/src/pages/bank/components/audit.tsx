import type { ReactNode } from 'react';

import type { AppStatus, Meta, Product } from '../../../api/types';
import type { StatusColor } from '../../../utils/format';
import { plural, rub } from '../../../utils/format';
import { FAULT_MODES, FAULT_SOURCE_TITLES } from './common';

export const ACTION_LABELS: Record<string, string> = {
    LOGIN: 'Вход',
    LOGIN_FAILED: 'Неудачный вход',
    STATUS_CHANGED: 'Смена статуса',
    DRAFT_CREATED: 'Создан черновик',
    DRAFT_DELETED: 'Удалён черновик',
    DOCUMENT_UPLOADED: 'Загружен документ',
    AGREEMENT_SIGNED: 'Подписан договор',
    JUSTIFICATION_GENERATED: 'Сформировано обоснование',
    ASSIGNED: 'Взята в работу',
    PIPELINE_RETRY: 'Повтор шага конвейера',
    FAULT_SET: 'Изменено состояние источника',
    DEMO_RESET: 'Сброс демо-данных',
};

export const ACTION_COLORS: Record<string, StatusColor> = {
    LOGIN: 'grey',
    LOGIN_FAILED: 'orange',
    STATUS_CHANGED: 'blue',
    DRAFT_CREATED: 'grey',
    DRAFT_DELETED: 'grey',
    DOCUMENT_UPLOADED: 'teal',
    AGREEMENT_SIGNED: 'green',
    JUSTIFICATION_GENERATED: 'blue',
    ASSIGNED: 'purple',
    PIPELINE_RETRY: 'orange',
    FAULT_SET: 'red',
    DEMO_RESET: 'red',
};

export const ENTITY_LABELS: Record<string, string> = {
    application: 'Заявка',
    user: 'Пользователь',
    simulator: 'Внешняя система',
    system: 'Стенд',
};

const statusLabel = (status: unknown, meta: Meta | undefined): string =>
    typeof status === 'string' ? (meta?.statuses[status as AppStatus]?.bank ?? status) : '—';

const plainValue = (value: unknown): string =>
    value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Детали записи журнала простыми словами вместо JSON. */
export function auditDetails(
    action: string,
    details: Record<string, unknown> | null | undefined,
    meta: Meta | undefined,
    products: Product[] | undefined,
): ReactNode {
    const d = details ?? {};
    switch (action) {
        case 'STATUS_CHANGED':
            return (
                <>
                    <div className='bank-strong'>
                        {statusLabel(d.from, meta)} → {statusLabel(d.to, meta)}
                    </div>
                    {typeof d.reason === 'string' && d.reason && <div className='bank-sub'>{d.reason}</div>}
                </>
            );
        case 'DRAFT_CREATED': {
            const product = products?.find((p) => p.code === d.product);
            return `${product?.name ?? plainValue(d.product)} · ${rub(d.amount as number)}`;
        }
        case 'DOCUMENT_UPLOADED': {
            const kind = typeof d.kind === 'string' ? (meta?.documents[d.kind] ?? d.kind) : 'Документ';
            return `${kind} · ${plainValue(d.file)}`;
        }
        case 'LOGIN_FAILED': {
            const seconds = typeof d.blocked_seconds === 'number' ? d.blocked_seconds : 0;
            const minutes = Math.ceil(seconds / 60);
            const blocked = seconds
                ? ` · вход заблокирован на ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`
                : '';
            const ip = typeof d.ip === 'string' && d.ip !== '—' ? ` · адрес ${d.ip}` : '';
            return `Логин ${plainValue(d.login)}${ip}${blocked}`;
        }
        case 'AGREEMENT_SIGNED': {
            const hash = typeof d.sha256 === 'string' ? ` · SHA-256 ${d.sha256.slice(0, 12)}…` : '';
            return `Договор подписан простой электронной подписью${hash}`;
        }
        case 'FAULT_SET': {
            const mode = FAULT_MODES[d.mode as keyof typeof FAULT_MODES];
            const latency =
                typeof d.latency_ms === 'number' && d.latency_ms > 0 ? ` · задержка ${d.latency_ms / 1000} с` : '';
            return `${mode?.label ?? plainValue(d.mode)}${latency}`;
        }
        default: {
            const entries = Object.entries(d);
            if (!entries.length) return <span className='muted'>—</span>;
            return entries.map(([key, value]) => `${key}: ${plainValue(value)}`).join(' · ');
        }
    }
}

export function entityTitle(entityType: string, entityId: string): string {
    if (entityType === 'simulator') return FAULT_SOURCE_TITLES[entityId] ?? entityId;
    return ENTITY_LABELS[entityType] ?? entityType;
}
