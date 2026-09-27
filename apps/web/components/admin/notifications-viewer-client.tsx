'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { errorMessage, fetchJson, sendJson } from '@/lib/http';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { z } from 'zod';

const notificationSchema = z.object({
    id: z.union([z.number(), z.string()]),
    to_email: z.string().optional(),
    template: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional().nullable(),
    created_at: z.string().optional(),
    sent_at: z.string().optional().nullable()
});
type Notification = z.infer<typeof notificationSchema>;

type BadgeVariant = 'default' | 'neutral' | 'success' | 'warning' | 'info' | 'danger' | 'coral';
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const STATUS_FILTERS: { label: string; value: string }[] = [
    { label: 'all', value: '' },
    { label: 'sent', value: 'sent' },
    { label: 'failed', value: 'failed' },
    { label: 'queued', value: 'queued' }
];

function statusBadgeVariant(status: string | undefined): BadgeVariant {
    switch (status) {
        case 'sent':
            return 'success';
        case 'failed':
            return 'danger';
        case 'queued':
            return 'info';
        case 'suppressed':
            return 'warning';
        default:
            return 'default';
    }
}

export function NotificationsViewerClient() {
    const t = useTranslations('admin.notifications');
    const [notifications, setNotifications] = React.useState<Notification[]>([]);
    const [stats, setStats] = React.useState<Record<string, unknown> | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [statusFilter, setStatusFilter] = React.useState<string>('');

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const qs = statusFilter ? `status=${encodeURIComponent(statusFilter)}` : '';
            const url = `/api/proxy/admin/notifications${qs ? `?${qs}` : ''}`;
            const data = await fetchJson(url, notificationSchema.array());
            setNotifications(data);
            try {
                const statsData = await fetchJson(
                    '/api/proxy/admin/notifications/stats',
                    z.record(z.string(), z.unknown())
                );
                setStats(statsData as Record<string, unknown>);
            } catch {
                setStats(null);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load notifications');
            setNotifications([]);
            setStats(null);
        } finally {
            setLoading(false);
        }
    }, [statusFilter]);

    React.useEffect(() => {
        load();
    }, [load]);

    const retry = React.useCallback(
        async (id: number | string) => {
            try {
                const { res, data } = await sendJson(`/api/proxy/admin/notifications/${id}/retry`, {
                    method: 'POST'
                });
                if (!res.ok) throw new Error(errorMessage(data) ?? `HTTP ${res.status}`);
                toast.success(t('retrySuccess'));
                await load();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Retry failed');
            }
        },
        [load, t]
    );

    if (loading) {
        return (
            <div className="space-y-4">
                <Card>
                    <CardHeader>
                        <Skeleton className="h-6 w-48" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-3/4" />
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <Skeleton className="h-6 w-48" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-3/4" />
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (error) {
        return <EmptyState title={t('error')} description={error} actionLabel={t('retry')} onAction={() => load()} />;
    }

    const totalSent = typeof stats?.['total_sent'] === 'number' ? (stats['total_sent'] as number) : undefined;
    const totalFailed = typeof stats?.['total_failed'] === 'number' ? (stats['total_failed'] as number) : undefined;
    const successRate = typeof stats?.['success_rate'] === 'number' ? (stats['success_rate'] as number) : undefined;
    const hasStats =
        stats !== null && (totalSent !== undefined || totalFailed !== undefined || successRate !== undefined);

    return (
        <div className="space-y-6">
            <h1 className="text-2xl font-bold">{t('title')}</h1>

            <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-sm font-medium">{hasStats ? `${t('sent')}` : t('stats')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {hasStats ? (
                            <div className="text-2xl font-bold">{totalSent ?? 0}</div>
                        ) : (
                            <div className="text-sm text-muted-foreground">{t('stats')}</div>
                        )}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle className="text-sm font-medium">
                            {hasStats ? `${t('failed')}` : t('stats')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {hasStats ? (
                            <div className="text-2xl font-bold">{totalFailed ?? 0}</div>
                        ) : (
                            <div className="text-sm text-muted-foreground">{t('stats')}</div>
                        )}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle className="text-sm font-medium">{hasStats ? `${t('stats')}` : t('stats')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {hasStats && successRate !== undefined ? (
                            <div className="text-2xl font-bold">{successRate.toFixed(1)}%</div>
                        ) : (
                            <div className="text-sm text-muted-foreground">{t('stats')}</div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <div className="flex flex-wrap gap-2">
                {STATUS_FILTERS.map((f) => {
                    const isActive = statusFilter === f.value;
                    const variant: ButtonVariant = isActive ? 'primary' : 'secondary';
                    return (
                        <Button key={f.value || 'all'} variant={variant} onClick={() => setStatusFilter(f.value)}>
                            {t(f.label)}
                        </Button>
                    );
                })}
            </div>

            {notifications.length === 0 ? (
                <EmptyState title={t('noResults')} />
            ) : (
                <Card>
                    <CardContent>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('recipient')}</TableHead>
                                    <TableHead>{t('template')}</TableHead>
                                    <TableHead>{t('status')}</TableHead>
                                    <TableHead>{t('errorCol')}</TableHead>
                                    <TableHead>{t('created')}</TableHead>
                                    <TableHead>{t('actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {notifications.map((n) => (
                                    <TableRow key={String(n.id)}>
                                        <TableCell>{n.to_email ?? '—'}</TableCell>
                                        <TableCell>{n.template ?? '—'}</TableCell>
                                        <TableCell>
                                            <Badge variant={statusBadgeVariant(n.status)}>
                                                {n.status ? t(n.status) : '—'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                                            {n.error ?? '—'}
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {n.created_at ?? '—'}
                                        </TableCell>
                                        <TableCell>
                                            {n.status === 'failed' && (
                                                <Button variant="ghost" onClick={() => retry(n.id)}>
                                                    {t('retry')}
                                                </Button>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
