'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Briefcase, CalendarCheck, FileText, Users } from 'lucide-react';
import { z } from 'zod';
import {
    activityItemSchema,
    candidateRowSchema,
    departmentStatSchema,
    trendPointSchema,
    vacancyListSchema,
    type ActivityItem,
    type CandidateStatus,
    type DepartmentStat,
    type TrendPoint,
    type Vacancy
} from '@/lib/schemas';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { DepartmentChart, TrendsChart } from './charts';
import { formatRelativeDate } from '@/lib/utils';

interface DashboardData {
    vacancies: Vacancy[];
    candidates: z.infer<typeof candidateRowSchema>[];
    activity: ActivityItem[];
    trends: TrendPoint[];
    departments: DepartmentStat[];
}

async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`${url} → bad payload`);
    return parsed.data;
}

export function DashboardClient() {
    const t = useTranslations('dashboard');
    const tCommon = useTranslations('common');
    const locale = useLocale();
    const [data, setData] = React.useState<DashboardData | null>(null);
    const [error, setError] = React.useState(false);
    const [loading, setLoading] = React.useState(true);

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const [vacancies, candidates, activity, trends, departments] = await Promise.all([
                fetchJson('/api/vacancies', vacancyListSchema),
                fetchJson('/api/proxy/candidates', z.array(candidateRowSchema)),
                fetchJson('/api/proxy/dashboard/activity', z.array(activityItemSchema)),
                fetchJson('/api/proxy/dashboard/application-trends', z.array(trendPointSchema)),
                fetchJson('/api/proxy/dashboard/department-stats', z.array(departmentStatSchema))
            ]);
            setData({ vacancies, candidates, activity, trends, departments });
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    if (loading) {
        return (
            <div aria-busy="true" aria-label={t('loading')} className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-28 rounded-xl" />
                    ))}
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                    <Skeleton className="h-64 rounded-xl" />
                    <Skeleton className="h-64 rounded-xl" />
                </div>
                <Skeleton className="h-56 rounded-xl" />
            </div>
        );
    }

    if (error || !data) {
        return <EmptyState title={t('error')} actionLabel={tCommon('retry')} onAction={load} />;
    }

    const activeVacancies = data.vacancies.filter((v) => v.status.toLowerCase() === 'active').length;
    const interviews = data.candidates.filter(
        (c) => (c.status ?? '').toLowerCase() === ('interview' satisfies CandidateStatus)
    ).length;

    const stats = [
        { key: 'totalVacancies', value: data.vacancies.length, icon: <Briefcase aria-hidden="true" /> },
        { key: 'activeVacancies', value: activeVacancies, icon: <FileText aria-hidden="true" /> },
        { key: 'candidates', value: data.candidates.length, icon: <Users aria-hidden="true" /> },
        { key: 'interviews', value: interviews, icon: <CalendarCheck aria-hidden="true" /> }
    ] as const;

    return (
        <div className="flex flex-col gap-6">
            {/* Stat cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {stats.map((s) => (
                    <Card key={s.key}>
                        <CardContent className="flex items-center gap-4 pt-6">
                            <span className="flex size-11 items-center justify-center rounded-lg bg-coral-500/15 text-coral-600 dark:text-coral-400 [&_svg]:size-5">
                                {s.icon}
                            </span>
                            <div>
                                <p className="text-2xl font-bold tabular-nums">
                                    {new Intl.NumberFormat(locale).format(s.value)}
                                </p>
                                <p className="text-sm text-muted-foreground">{t(`stats.${s.key}`)}</p>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Charts */}
            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('trends.title')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <TrendsChart data={data.trends} />
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('departments.title')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <DepartmentChart data={data.departments} />
                    </CardContent>
                </Card>
            </div>

            {/* Activity feed */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('activity.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {data.activity.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('activity.empty')}</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {data.activity.map((a, i) => (
                                <li key={i} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <span className="flex-1 text-sm">{a.description}</span>
                                    <time dateTime={a.timestamp} className="shrink-0 text-xs text-muted-foreground">
                                        {formatRelativeDate(a.timestamp, locale)}
                                    </time>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            {/* Status distribution strip — quick semantic-color demo */}
            {data.candidates.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle>{t('stats.candidates')}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                        {(['pending', 'interview', 'accepted', 'rejected'] as const).map((s) => {
                            const n = data.candidates.filter((c) => (c.status ?? '').toLowerCase() === s).length;
                            return (
                                <span key={s} className="inline-flex items-center gap-1.5">
                                    <StatusBadge status={s} />
                                    <span className="text-sm tabular-nums text-muted-foreground">{n}</span>
                                </span>
                            );
                        })}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
