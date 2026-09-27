'use client';

import { useTranslations } from 'next-intl';
import { Badge } from './badge';

// Canonical candidate statuses (lowercase) → semantic color.
// pending→warning, interview→info, accepted→success, rejected→danger.
const STATUS_VARIANT = {
    pending: 'warning',
    interview: 'info',
    accepted: 'success',
    rejected: 'danger',
    // vacancy lifecycle
    active: 'success',
    paused: 'warning',
    closed: 'neutral',
    draft: 'neutral'
} as const;

export type Status = keyof typeof STATUS_VARIANT;

export function StatusBadge({ status, className }: { status: string; className?: string }) {
    const t = useTranslations('status');
    const key = status.toLowerCase() as Status;
    const variant = STATUS_VARIANT[key] ?? 'neutral';
    const label = key in STATUS_VARIANT ? t(key as Status) : status;
    return (
        <Badge variant={variant} className={className}>
            {label}
        </Badge>
    );
}
