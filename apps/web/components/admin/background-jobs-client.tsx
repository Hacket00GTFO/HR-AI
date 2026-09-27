'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { fetchJson, sendJson } from '@/lib/http';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { jobExecutionSchema, jobStatsSchema, type JobExecution, type JobStats } from '@/lib/schemas';

const statusVariant: Record<JobExecution['status'], 'info' | 'warning' | 'success' | 'danger' | 'neutral'> = {
    pending: 'info',
    running: 'warning',
    completed: 'success',
    failed: 'danger',
    retry: 'neutral'
};

export function BackgroundJobsClient() {
    const t = useTranslations('admin.jobs');
    const tCommon = useTranslations('common');
    const [jobs, setJobs] = React.useState<JobExecution[]>([]);
    const [stats, setStats] = React.useState<JobStats | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const [jobsRes, statsData] = await Promise.all([
                fetchJson('/api/proxy/admin/jobs', z.object({ data: jobExecutionSchema.array() })),
                fetchJson('/api/proxy/admin/jobs/stats', jobStatsSchema)
            ]);
            setJobs(jobsRes.data);
            setStats(statsData);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    async function retryQueue(queue: string) {
        try {
            const { res } = await sendJson(`/api/proxy/admin/jobs/${queue}/retry`, { method: 'POST' });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('retrySuccess'));
            await load();
        } catch {
            toast.error(t('error'));
        }
    }

    async function purgeQueue(queue: string) {
        try {
            const { res } = await sendJson(`/api/proxy/admin/jobs/${queue}/failed`, { method: 'DELETE' });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('purgeSuccess'));
            await load();
        } catch {
            toast.error(t('error'));
        }
    }

    if (loading) {
        return (
            <div className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
                    {[0, 1, 2, 3, 4].map((i) => (
                        <Skeleton key={i} className="h-24 rounded-xl" />
                    ))}
                </div>
                <Skeleton className="h-64 rounded-xl" />
            </div>
        );
    }

    if (error) {
        return <EmptyState title={t('error')} actionLabel={tCommon('retry')} onAction={load} />;
    }

    const statCards: Array<{ label: string; value: number; color: string }> = [
        { label: t('total'), value: stats?.total ?? 0, color: '' },
        { label: t('pending'), value: stats?.pending ?? 0, color: 'text-blue-600 dark:text-blue-400' },
        { label: t('running'), value: stats?.running ?? 0, color: 'text-amber-600 dark:text-amber-400' },
        { label: t('completed'), value: stats?.completed ?? 0, color: 'text-emerald-600 dark:text-emerald-400' },
        { label: t('failed'), value: stats?.failed ?? 0, color: 'text-red-600 dark:text-red-400' }
    ];

    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-bold">{t('title')}</h1>

            {/* Stats cards */}
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
                {statCards.map((s) => (
                    <Card key={s.label}>
                        <CardContent className="pt-6">
                            <p className="text-sm text-muted-foreground">{s.label}</p>
                            <p className={`mt-1 text-2xl font-bold tabular-nums ${s.color}`}>{s.value}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Jobs table */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {jobs.length === 0 ? (
                        <EmptyState title={t('noResults')} />
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('queue')}</TableHead>
                                    <TableHead>{t('type')}</TableHead>
                                    <TableHead>{t('status')}</TableHead>
                                    <TableHead>{t('attempts')}</TableHead>
                                    <TableHead>{t('created')}</TableHead>
                                    <TableHead className="text-right">{t('actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {jobs.map((job, i) => (
                                    <TableRow key={`${job.id ?? i}`}>
                                        <TableCell className="font-medium">{job.queue}</TableCell>
                                        <TableCell className="text-muted-foreground">{job.job_type}</TableCell>
                                        <TableCell>
                                            <Badge variant={statusVariant[job.status]}>{job.status}</Badge>
                                        </TableCell>
                                        <TableCell className="tabular-nums">{job.attempts}</TableCell>
                                        <TableCell className="text-muted-foreground">
                                            {job.created_at ? new Date(job.created_at).toLocaleString() : '—'}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {job.status === 'failed' && (
                                                <div className="flex justify-end gap-1">
                                                    <Button
                                                        size="sm"
                                                        variant="secondary"
                                                        onClick={() => retryQueue(job.queue)}
                                                    >
                                                        {t('retry')}
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="danger"
                                                        onClick={() => purgeQueue(job.queue)}
                                                    >
                                                        {t('purge')}
                                                    </Button>
                                                </div>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
