'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { fetchJson } from '@/lib/http';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { auditLogResponseSchema, auditStatsSchema, type AuditLogResponse, type AuditStats } from '@/lib/schemas';

interface AuditFilters {
    actor: string;
    action: string;
    entity: string;
}

const EMPTY_FILTERS: AuditFilters = { actor: '', action: '', entity: '' };

export function AuditLogClient() {
    const t = useTranslations('admin.audit');
    const [data, setData] = React.useState<AuditLogResponse | null>(null);
    const [stats, setStats] = React.useState<AuditStats | null>(null);
    const [loading, setLoading] = React.useState<boolean>(true);
    const [error, setError] = React.useState<boolean>(false);
    const [filters, setFilters] = React.useState<AuditFilters>(EMPTY_FILTERS);
    const [draft, setDraft] = React.useState<AuditFilters>(EMPTY_FILTERS);
    const [offset, setOffset] = React.useState<number>(0);
    const limit = 50;

    const load = React.useCallback(async () => {
        try {
            setLoading(true);
            setError(false);
            const params = new URLSearchParams();
            params.set('limit', String(limit));
            params.set('offset', String(offset));
            if (filters.actor) params.set('actor', filters.actor);
            if (filters.action) params.set('action', filters.action);
            if (filters.entity) params.set('entity', filters.entity);
            const [logResult, statsResult] = await Promise.all([
                fetchJson(`/api/proxy/admin/audit?${params.toString()}`, auditLogResponseSchema),
                fetchJson('/api/proxy/admin/audit/stats', auditStatsSchema)
            ]);
            setData(logResult);
            setStats(statsResult);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [filters, offset]);

    React.useEffect(() => {
        load();
    }, [load]);

    const applyFilters = () => {
        setFilters(draft);
        setOffset(0);
    };

    const exportCsv = async () => {
        try {
            const res = await fetch(`/api/proxy/admin/audit?format=csv&limit=10000`);
            if (!res.ok) return;
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'audit-log.csv';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch {
            /* ignore export errors */
        }
    };

    const rows = data?.data ?? [];
    const hasPrev = offset > 0;
    const hasNext = data != null && offset + limit < data.total;

    if (loading && data == null) {
        return (
            <div className="space-y-6">
                <div>
                    <Skeleton className="h-8 w-48" />
                </div>
                <div className="flex flex-wrap gap-3">
                    <Skeleton className="h-10 w-40" />
                    <Skeleton className="h-10 w-40" />
                    <Skeleton className="h-10 w-40" />
                    <Skeleton className="h-10 w-24" />
                </div>
                <div className="rounded-xl border border-border bg-card shadow-sm">
                    {[0, 1, 2, 3, 4].map((i) => (
                        <Skeleton key={i} className="h-12 w-full rounded-none first:rounded-t-lg last:rounded-b-lg" />
                    ))}
                </div>
            </div>
        );
    }

    if (error && data == null) {
        return <EmptyState title={t('error')} actionLabel={t('retry')} onAction={load} />;
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-semibold">{t('title')}</h1>
                <Button variant="secondary" size="sm" onClick={exportCsv}>
                    {t('export')}
                </Button>
            </div>

            {/* Filter bar */}
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('actor')}</label>
                    <Input
                        value={draft.actor}
                        onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value }))}
                        placeholder={t('actor')}
                        className="w-48"
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('action')}</label>
                    <Input
                        value={draft.action}
                        onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))}
                        placeholder={t('action')}
                        className="w-48"
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('entity')}</label>
                    <Input
                        value={draft.entity}
                        onChange={(e) => setDraft((d) => ({ ...d, entity: e.target.value }))}
                        placeholder={t('entity')}
                        className="w-48"
                    />
                </div>
                <Button size="sm" onClick={applyFilters}>
                    {t('apply')}
                </Button>
            </div>

            {/* Stats summary */}
            {stats && (
                <div className="grid gap-4 sm:grid-cols-3">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-sm font-medium text-muted-foreground">{t('total')}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-2xl font-semibold">{stats.total}</p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-sm font-medium text-muted-foreground">
                                {t('topActions')}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-wrap gap-2">
                                {stats.topActions.map((a) => (
                                    <Badge key={a.action} variant="neutral">
                                        {a.action} · {a.count}
                                    </Badge>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-sm font-medium text-muted-foreground">
                                {t('topActors')}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-wrap gap-2">
                                {stats.topActors.map((a) => (
                                    <Badge key={a.actor} variant="neutral">
                                        {a.actor} · {a.count}
                                    </Badge>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* Table */}
            {rows.length === 0 ? (
                <EmptyState title={t('noResults')} />
            ) : (
                <div className="rounded-xl border border-border bg-card shadow-sm">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('timestamp')}</TableHead>
                                <TableHead>{t('actor')}</TableHead>
                                <TableHead>{t('action')}</TableHead>
                                <TableHead>{t('entity')}</TableHead>
                                <TableHead>{t('entityId')}</TableHead>
                                <TableHead>{t('metadata')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row, i) => {
                                const actor =
                                    row.actorRole ?? (row.actorId != null ? `#${row.actorId}` : t('unknownActor'));
                                const meta = row.metadata != null ? JSON.stringify(row.metadata) : '';
                                return (
                                    <TableRow key={`${row.id ?? i}`}>
                                        <TableCell className="whitespace-nowrap text-muted-foreground">
                                            {row.timestamp}
                                        </TableCell>
                                        <TableCell className="font-medium">{actor}</TableCell>
                                        <TableCell>
                                            <Badge variant="info">{row.action}</Badge>
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">{row.entity}</TableCell>
                                        <TableCell className="text-muted-foreground">
                                            {row.entityId != null ? row.entityId : '—'}
                                        </TableCell>
                                        <TableCell className="max-w-xs truncate text-muted-foreground">
                                            {meta || '—'}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}

            {/* Pagination */}
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    {data ? `${offset + 1}–${Math.min(offset + rows.length, data.total)} / ${data.total}` : ''}
                </p>
                <div className="flex gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={!hasPrev || loading}
                        onClick={() => setOffset((o) => Math.max(0, o - limit))}
                    >
                        {t('prev')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={!hasNext || loading}
                        onClick={() => setOffset((o) => o + limit)}
                    >
                        {t('next')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
