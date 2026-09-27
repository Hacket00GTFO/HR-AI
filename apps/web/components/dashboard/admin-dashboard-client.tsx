'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Database, ShieldCheck, UserCog, Users } from 'lucide-react';
import { z } from 'zod';
import { adminSummarySchema, auditItemSchema, type AdminSummary, type AuditItem } from '@/lib/schemas';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils';

async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`${url} → bad payload`);
    return parsed.data;
}

/** Platform dashboard for the admin role — accounts, system health, audit. */
export function AdminDashboardClient() {
    const t = useTranslations('dashboard.admin');
    const tCommon = useTranslations('common');
    const locale = useLocale();
    const [summary, setSummary] = React.useState<AdminSummary | null>(null);
    const [audit, setAudit] = React.useState<AuditItem[]>([]);
    const [error, setError] = React.useState(false);
    const [loading, setLoading] = React.useState(true);

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const [s, a] = await Promise.all([
                fetchJson('/api/proxy/dashboard/admin/summary', adminSummarySchema),
                fetchJson('/api/proxy/dashboard/admin/audit', auditItemSchema.array())
            ]);
            setSummary(s);
            setAudit(a);
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
            <div aria-busy="true" aria-label={tCommon('loading')} className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-28 rounded-xl" />
                    ))}
                </div>
                <Skeleton className="h-64 rounded-xl" />
            </div>
        );
    }

    if (error || !summary) {
        return <EmptyState title={t('error')} actionLabel={tCommon('retry')} onAction={load} />;
    }

    const stats = [
        { key: 'hrAccounts', value: summary.hrAccounts, icon: <Users aria-hidden="true" /> },
        { key: 'adminAccounts', value: summary.adminAccounts, icon: <ShieldCheck aria-hidden="true" /> },
        { key: 'dbStatus', value: summary.dbOk, icon: <Database aria-hidden="true" /> }
    ] as const;

    return (
        <div className="flex flex-col gap-6">
            {/* Stat cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {stats.map((s) => (
                    <Card key={s.key}>
                        <CardContent className="flex items-center gap-4 pt-6">
                            <span className="flex size-11 items-center justify-center rounded-lg bg-coral-500/15 text-coral-600 dark:text-coral-400 [&_svg]:size-5">
                                {s.icon}
                            </span>
                            <div>
                                <p className="text-2xl font-bold tabular-nums">
                                    {typeof s.value === 'boolean'
                                        ? s.value
                                            ? t('dbOk')
                                            : t('dbDown')
                                        : new Intl.NumberFormat(locale).format(s.value)}
                                </p>
                                <p className="text-sm text-muted-foreground">{t(`stats.${s.key}`)}</p>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Account management shortcut */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('accounts.title')}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">{t('accounts.description')}</p>
                    <Link
                        href="/admin"
                        className="inline-flex w-fit items-center gap-2 rounded-md bg-coral-600 px-4 py-2 text-sm font-medium text-white hover:bg-coral-700"
                    >
                        <UserCog className="size-4" aria-hidden="true" />
                        {t('accounts.manage')}
                    </Link>
                </CardContent>
            </Card>

            {/* Recent accounts */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('recent.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {summary.recentAccounts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('recent.empty')}</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {summary.recentAccounts.map((a) => (
                                <li key={a.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                                    <div className="flex-1">
                                        <p className="text-sm font-medium">{a.name}</p>
                                        <p className="text-xs text-muted-foreground">{a.email}</p>
                                    </div>
                                    <Badge variant={a.role === 'admin' ? 'info' : 'neutral'}>{a.role}</Badge>
                                    {a.updatedAt && (
                                        <time dateTime={a.updatedAt} className="shrink-0 text-xs text-muted-foreground">
                                            {formatDate(a.updatedAt, locale)}
                                        </time>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            {/* Audit feed */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('audit.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {audit.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {audit.map((a, i) => (
                                <li key={`${a.id}-${i}`} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                                    <div className="flex-1">
                                        <p className="text-sm">
                                            <span className="font-medium">{a.action}</span>
                                            <span className="text-muted-foreground">
                                                {' '}
                                                —{' '}
                                                {a.actorRole ??
                                                    (a.actorId != null ? `#${a.actorId}` : t('audit.unknownActor'))}
                                            </span>
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {a.entity}
                                            {a.entityId != null ? ` #${a.entityId}` : ''}
                                        </p>
                                    </div>
                                    <time dateTime={a.timestamp} className="shrink-0 text-xs text-muted-foreground">
                                        {formatDate(a.timestamp, locale)}
                                    </time>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
