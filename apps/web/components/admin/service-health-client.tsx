'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { fetchJson } from '@/lib/http';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { healthSummarySchema, type HealthSummary } from '@/lib/schemas';
import { Activity, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Radio } from 'lucide-react';

const POLL_INTERVAL_MS = 10_000;

export function ServiceHealthClient() {
    const t = useTranslations();
    const [data, setData] = React.useState<HealthSummary | null>(null);
    const [loading, setLoading] = React.useState<boolean>(true);
    const [refreshing, setRefreshing] = React.useState<boolean>(false);
    const [error, setError] = React.useState<boolean>(false);
    const [autoRefresh, setAutoRefresh] = React.useState<boolean>(true);
    const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);

    const load = React.useCallback(async (isManual = false) => {
        if (isManual) {
            setRefreshing(true);
        }
        try {
            setError(false);
            const result = await fetchJson('/api/proxy/admin/health', healthSummarySchema);
            setData(result);
            setLastUpdated(new Date());
        } catch {
            setError(true);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    // Initial load
    React.useEffect(() => {
        load();
    }, [load]);

    // Polling — only when auto-refresh is enabled
    React.useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(() => load(false), POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [autoRefresh, load]);

    // Re-fetch when tab regains visibility
    React.useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible' && autoRefresh) {
                load(false);
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [autoRefresh, load]);

    const statusBadgeClass = (status: string) => {
        switch (status) {
            case 'healthy':
                return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
            case 'degraded':
                return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
            case 'down':
                return 'bg-red-500/15 text-red-700 dark:text-red-400';
            default:
                return 'bg-muted text-muted-foreground';
        }
    };

    const StatusIcon = ({ status }: { status: string }) => {
        switch (status) {
            case 'healthy':
                return <CheckCircle2 className="h-4 w-4" />;
            case 'degraded':
                return <AlertTriangle className="h-4 w-4" />;
            case 'down':
                return <XCircle className="h-4 w-4" />;
            default:
                return <Activity className="h-4 w-4" />;
        }
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <div>
                    <Skeleton className="h-8 w-48" />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <Card key={i}>
                            <CardHeader>
                                <Skeleton className="h-5 w-32" />
                            </CardHeader>
                            <CardContent>
                                <Skeleton className="h-4 w-full" />
                                <Skeleton className="mt-2 h-4 w-2/3" />
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </div>
        );
    }

    if (error && !data) {
        return (
            <EmptyState
                title={t('admin.health.error')}
                actionLabel={t('admin.health.retry')}
                onAction={() => load(true)}
            />
        );
    }

    if (!data) {
        return null;
    }

    const services = data.services ?? [];
    const counts = {
        total: services.length,
        healthy: services.filter((s) => s.status === 'healthy').length,
        degraded: services.filter((s) => s.status === 'degraded').length,
        down: services.filter((s) => s.status === 'down').length
    };

    const lastUpdatedStr = lastUpdated
        ? lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '—';

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <h1 className="text-2xl font-semibold">{t('admin.health.title')}</h1>
                <div className="flex items-center gap-3">
                    {/* Live indicator */}
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        {autoRefresh ? (
                            <span className="flex items-center gap-1.5">
                                <span className="relative flex h-2.5 w-2.5">
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                                </span>
                                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                    {t('admin.health.live')}
                                </span>
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                                <Radio className="h-3.5 w-3.5" />
                                <span>{t('admin.health.paused')}</span>
                            </span>
                        )}
                    </div>
                    {/* Auto-refresh toggle */}
                    <Button
                        variant={autoRefresh ? 'primary' : 'secondary'}
                        size="sm"
                        onClick={() => setAutoRefresh((v) => !v)}
                    >
                        {autoRefresh ? t('admin.health.autoOn') : t('admin.health.autoOff')}
                    </Button>
                    {/* Manual refresh */}
                    <Button
                        variant="ghost"
                        size="sm"
                        loading={refreshing}
                        onClick={() => load(true)}
                        aria-label={t('admin.health.refresh')}
                    >
                        <RefreshCw className={refreshing ? 'animate-spin' : ''} />
                    </Button>
                </div>
            </div>

            {/* Last updated + summary badges */}
            <div className="flex flex-wrap items-center gap-3">
                <Badge variant="neutral">
                    {t('admin.health.total')}: {counts.total}
                </Badge>
                <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                    {t('admin.health.healthy')}: {counts.healthy}
                </Badge>
                <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
                    {t('admin.health.degraded')}: {counts.degraded}
                </Badge>
                <Badge className="bg-red-500/15 text-red-700 dark:text-red-400">
                    {t('admin.health.down')}: {counts.down}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                    {t('admin.health.lastUpdated')}: {lastUpdatedStr}
                </span>
            </div>

            {/* Service cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {services.map((service) => (
                    <Card key={service.name} className="transition-shadow">
                        <CardHeader>
                            <CardTitle className="flex items-center justify-between text-base">
                                <span className="truncate">{service.name}</span>
                                <Badge className={statusBadgeClass(service.status)}>
                                    <span className="mr-1 inline-flex">
                                        <StatusIcon status={service.status} />
                                    </span>
                                    {service.status}
                                </Badge>
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            {service.latencyMs != null ? (
                                <p className="text-sm text-muted-foreground">
                                    {t('admin.health.latencyMs')}: {service.latencyMs} ms
                                </p>
                            ) : (
                                <p className="text-sm text-muted-foreground">—</p>
                            )}
                            {service.error && (
                                <p
                                    className="mt-1 truncate text-xs text-red-600 dark:text-red-400"
                                    title={service.error}
                                >
                                    {service.error}
                                </p>
                            )}
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
