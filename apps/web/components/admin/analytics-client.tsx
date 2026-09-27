'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { fetchJson } from '@/lib/http';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    analyticsOverviewSchema,
    analyticsTrendSchema,
    type AnalyticsOverview,
    type AnalyticsTrend
} from '@/lib/schemas';

type Period = '7d' | '30d' | '90d';

const FUNNEL_STAGES = ['applied', 'screened', 'interview', 'offer', 'accepted'] as const;

export function AnalyticsClient() {
    const t = useTranslations('admin.analytics');
    const tCommon = useTranslations('common');
    const [overview, setOverview] = React.useState<AnalyticsOverview | null>(null);
    const [trend, setTrend] = React.useState<AnalyticsTrend | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(false);
    const [period, setPeriod] = React.useState<Period>('30d');

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const [overviewData, trendData] = await Promise.all([
                fetchJson('/api/proxy/admin/analytics/overview', analyticsOverviewSchema),
                fetchJson(
                    `/api/proxy/admin/analytics/trends?metric=applications&period=${period}`,
                    analyticsTrendSchema
                )
            ]);
            setOverview(overviewData);
            setTrend(trendData);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [period]);

    React.useEffect(() => {
        load();
    }, [load]);

    function exportCsv() {
        window.open('/api/proxy/admin/analytics/export');
    }

    if (loading) {
        return (
            <div className="flex flex-col gap-6">
                <Skeleton className="h-10 w-64" />
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-28 rounded-xl" />
                    ))}
                </div>
                <Skeleton className="h-64 rounded-xl" />
                <Skeleton className="h-48 rounded-xl" />
            </div>
        );
    }

    if (error || !overview) {
        return <EmptyState title={t('error')} actionLabel={tCommon('retry')} onAction={load} />;
    }

    const trendData = trend?.data ?? [];
    const maxTrendValue = Math.max(1, ...trendData.map((p) => p.value));

    // Build funnel lookup from array
    const funnelMap = new Map(overview.funnel.map((f) => [f.status, f.count]));
    const funnelTotal = Math.max(1, funnelMap.get('applied') ?? 0);

    const kpiCards: Array<{ label: string; value: number }> = [
        { label: t('totalVacancies'), value: overview.totalVacancies },
        { label: t('activeVacancies'), value: overview.activeVacancies },
        { label: t('totalCandidates'), value: overview.totalCandidates },
        { label: t('totalApplications'), value: overview.totalApplications }
    ];

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 rounded-md border p-1">
                        {(['7d', '30d', '90d'] as Period[]).map((p) => (
                            <Button
                                key={p}
                                size="sm"
                                variant={period === p ? 'primary' : 'ghost'}
                                onClick={() => setPeriod(p)}
                            >
                                {p === '7d' ? t('period7d') : p === '30d' ? t('period30d') : t('period90d')}
                            </Button>
                        ))}
                    </div>
                    <Button variant="secondary" onClick={exportCsv}>
                        {t('export')}
                    </Button>
                </div>
            </div>

            {/* Primary KPI cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {kpiCards.map((kpi) => (
                    <Card key={kpi.label}>
                        <CardContent className="pt-6">
                            <p className="text-sm text-muted-foreground">{kpi.label}</p>
                            <p className="mt-1 text-2xl font-bold tabular-nums">
                                {new Intl.NumberFormat().format(kpi.value)}
                            </p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Secondary KPIs */}
            <div className="grid gap-4 sm:grid-cols-2">
                <Card>
                    <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">{t('applications30d')}</p>
                        <p className="mt-1 text-2xl font-bold tabular-nums">
                            {new Intl.NumberFormat().format(overview.applicationsLast30Days)}
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">{t('hired')}</p>
                        <p className="mt-1 text-2xl font-bold tabular-nums">
                            {new Intl.NumberFormat().format(overview.hiredCandidates)}
                        </p>
                    </CardContent>
                </Card>
            </div>

            {/* Trends section */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('trends')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {trendData.length === 0 ? (
                        <EmptyState title={t('noData')} />
                    ) : (
                        <div className="flex h-64 items-end gap-1">
                            {trendData.map((point, idx) => (
                                <div key={idx} className="flex flex-1 flex-col items-center gap-1">
                                    <div
                                        className="w-full rounded-t bg-coral-500 transition-all"
                                        style={{ height: `${(point.value / maxTrendValue) * 100}%` }}
                                        title={`${point.value}`}
                                    />
                                    <span className="truncate text-[10px] text-muted-foreground">{point.date}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Funnel section */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('funnel')}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    {FUNNEL_STAGES.map((stage) => {
                        const count = funnelMap.get(stage) ?? 0;
                        const pct = (count / funnelTotal) * 100;
                        return (
                            <div key={stage} className="flex flex-col gap-1">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="font-medium capitalize">{stage}</span>
                                    <span className="text-muted-foreground">
                                        {new Intl.NumberFormat().format(count)} ({pct.toFixed(1)}%)
                                    </span>
                                </div>
                                <div className="h-4 w-full overflow-hidden rounded-md bg-muted">
                                    <div
                                        className="h-full rounded-md bg-coral-500 transition-all"
                                        style={{ width: `${pct}%` }}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </CardContent>
            </Card>

            {/* Department breakdown */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('departments')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {overview.vacanciesByDepartment.length === 0 ? (
                        <EmptyState title={t('noData')} />
                    ) : (
                        <div className="flex flex-col divide-y divide-border">
                            {overview.vacanciesByDepartment.map((dept) => (
                                <div
                                    key={dept.department}
                                    className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                                >
                                    <Badge variant="info">{dept.department}</Badge>
                                    <span className="text-sm tabular-nums">
                                        {new Intl.NumberFormat().format(dept.count)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
