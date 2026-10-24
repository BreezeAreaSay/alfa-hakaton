import { Button } from '@alfalab/core-components/button';
import { Plate } from '@alfalab/core-components/plate';
import { Spinner } from '@alfalab/core-components/spinner';
import { Status } from '@alfalab/core-components/status';
import { Typography } from '@alfalab/core-components/typography';
import { CheckmarkMIcon } from '@alfalab/icons-glyph/CheckmarkMIcon';
import { ClockMIcon } from '@alfalab/icons-glyph/ClockMIcon';
import { CrossMIcon } from '@alfalab/icons-glyph/CrossMIcon';
import { ExclamationMIcon } from '@alfalab/icons-glyph/ExclamationMIcon';
import type { ReactNode } from 'react';

import { ApiError } from '../api/client';
import type { AppStatus, Step } from '../api/types';
import { STATUS_COLORS, type StatusColor } from '../utils/format';

export function PageHead({
    title,
    subtitle,
    actions,
}: {
    title: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <div className='page-head'>
            <div className='stack-8'>
                <Typography.TitleResponsive tag='h1' view='large' font='system' weight='bold'>
                    {title}
                </Typography.TitleResponsive>
                {subtitle && (
                    <Typography.Text view='primary-medium' color='secondary' tag='div'>
                        {subtitle}
                    </Typography.Text>
                )}
            </div>
            {actions && <div className='row'>{actions}</div>}
        </div>
    );
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
    return (
        <div className='row row--between' style={{ marginBottom: 16 }}>
            <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                {children}
            </Typography.Title>
            {extra}
        </div>
    );
}

export function StatusBadge({ status, label, size = 24 }: { status: AppStatus; label: string; size?: 20 | 24 | 32 }) {
    return (
        <Status color={STATUS_COLORS[status]} view='muted-alt' uppercase={false} size={size}>
            {label}
        </Status>
    );
}

export function Badge({ color, children }: { color: StatusColor; children: ReactNode }) {
    return (
        <Status color={color} view='muted-alt' uppercase={false} size={20}>
            {children}
        </Status>
    );
}

export function Loader({ text = 'Загружаем…' }: { text?: string }) {
    return (
        <div className='empty'>
            <Spinner visible={true} size={24} lineWidth={3} />
            <Typography.Text view='primary-small' color='secondary' tag='div' style={{ marginTop: 12 }}>
                {text}
            </Typography.Text>
        </div>
    );
}

export function ErrorPlate({ error, title = 'Не получилось' }: { error: unknown; title?: string }) {
    if (!error) return null;
    const message = error instanceof ApiError || error instanceof Error ? error.message : String(error);
    return (
        <Plate view='negative' rounded={true} title={title} limitContentWidth={false}>
            {message}
        </Plate>
    );
}

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
    return (
        <div className='empty'>
            <Typography.Title tag='div' view='xsmall' font='system' weight='bold'>
                {title}
            </Typography.Title>
            {text && (
                <Typography.Text view='primary-medium' color='secondary' tag='p' style={{ marginTop: 8 }}>
                    {text}
                </Typography.Text>
            )}
            {action && <div style={{ marginTop: 24 }}>{action}</div>}
        </div>
    );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
    return (
        <dl className='kv'>
            {items.map(([key, value], index) => (
                <div key={index}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function Metric({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
    return (
        <div>
            <div className='metric__label'>{label}</div>
            <div className='metric__value'>{value}</div>
            {hint && (
                <div className='metric__label' style={{ marginTop: 4 }}>
                    {hint}
                </div>
            )}
        </div>
    );
}

const STEP_ICON: Record<Step['status'], ReactNode> = {
    DONE: <CheckmarkMIcon width={16} height={16} aria-label='Выполнено' />,
    SKIPPED: <CheckmarkMIcon width={16} height={16} aria-label='Пропущено' />,
    RUNNING: <ClockMIcon width={16} height={16} aria-label='Выполняется' />,
    WAITING: <ExclamationMIcon width={16} height={16} aria-label='Ожидание' />,
    FAILED: <CrossMIcon width={16} height={16} aria-label='Ошибка' />,
    PENDING: null,
};

const STEP_DOT: Record<Step['status'], string> = {
    DONE: 'timeline__dot--done',
    SKIPPED: 'timeline__dot--skipped',
    RUNNING: 'timeline__dot--active pulse',
    WAITING: 'timeline__dot--waiting pulse',
    FAILED: 'timeline__dot--failed',
    PENDING: '',
};

export function StepList({ steps, showErrors = false }: { steps: Step[]; showErrors?: boolean }) {
    return (
        <ol className='timeline'>
            {steps.map((step) => (
                <li key={step.step} className='timeline__item'>
                    <span className={`timeline__dot ${STEP_DOT[step.status]}`}>{STEP_ICON[step.status]}</span>
                    <div>
                        <Typography.Text
                            view='primary-medium'
                            weight={step.status === 'PENDING' ? 'regular' : 'medium'}
                            tag='div'
                        >
                            {step.title}
                        </Typography.Text>
                        <Typography.Text view='primary-small' color='secondary' tag='div'>
                            {step.status === 'SKIPPED' && 'Не требуется'}
                            {step.status === 'WAITING' && `${step.waiting_text}. Повторим автоматически`}
                            {step.status === 'RUNNING' && step.waiting_text}
                            {step.status === 'FAILED' && 'Источник недоступен — заявку проверит специалист'}
                        </Typography.Text>
                        {showErrors && step.error && (
                            <Typography.Text view='primary-small' color='negative' tag='div'>
                                {step.error} · попыток: {step.attempts}
                            </Typography.Text>
                        )}
                    </div>
                </li>
            ))}
        </ol>
    );
}

export function ConfirmButtons({
    onConfirm,
    onCancel,
    confirmText,
    loading,
    disabled,
}: {
    onConfirm: () => void;
    onCancel?: () => void;
    confirmText: string;
    loading?: boolean;
    disabled?: boolean;
}) {
    return (
        <div className='row'>
            <Button view='primary' size={48} onClick={onConfirm} loading={loading} disabled={disabled}>
                {confirmText}
            </Button>
            {onCancel && (
                <Button view='secondary' size={48} onClick={onCancel}>
                    Отмена
                </Button>
            )}
        </div>
    );
}
