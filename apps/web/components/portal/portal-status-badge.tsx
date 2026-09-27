'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

// Portal-scoped status badge — the shared StatusBadge only covers candidate
// and vacancy lifecycles; portal adds leave/ticket/expense states.
const VARIANT = {
    pending: 'warning',
    approved: 'success',
    rejected: 'danger',
    cancelled: 'neutral',
    open: 'info',
    in_progress: 'info',
    resolved: 'success',
    closed: 'neutral',
    draft: 'neutral',
    submitted: 'info',
    paid: 'success',
    active: 'success'
} as const;

type KnownStatus = keyof typeof VARIANT;

export function PortalStatusBadge({ status, className }: { status: string; className?: string }) {
    const t = useTranslations('portal.status');
    const key = status.toLowerCase() as KnownStatus;
    const known = key in VARIANT;
    return (
        <Badge variant={known ? VARIANT[key] : 'neutral'} className={className}>
            {known ? t(key) : status}
        </Badge>
    );
}
