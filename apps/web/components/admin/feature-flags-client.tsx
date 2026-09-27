'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { fetchJson, sendJson } from '@/lib/http';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { z } from 'zod';

const flagSchema = z.object({
    id: z.union([z.number(), z.string()]),
    key: z.string(),
    description: z.string().optional().nullable(),
    enabled: z.boolean(),
    rollout_percentage: z.number().optional().default(0),
    updated_at: z.string().optional()
});
type Flag = z.infer<typeof flagSchema>;

export function FeatureFlagsClient() {
    const t = useTranslations();
    const [flags, setFlags] = React.useState<Flag[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchJson('/api/proxy/admin/feature-flags', flagSchema.array());
            setFlags(data);
        } catch (err) {
            console.error('Failed to load feature flags', err);
            setError(t('admin.featureFlags.loadError'));
        } finally {
            setLoading(false);
        }
    }, [t]);

    React.useEffect(() => {
        load();
    }, [load]);

    const toggleFlag = async (key: string, currentEnabled: boolean) => {
        try {
            const { res } = await sendJson(`/api/proxy/admin/feature-flags/${key}`, {
                method: 'PUT',
                body: { enabled: !currentEnabled }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('admin.featureFlags.toggleSuccess'));
            await load();
        } catch (err) {
            console.error('Failed to toggle flag', err);
            toast.error(t('admin.featureFlags.toggleError'));
        }
    };

    const updateRollout = async (key: string, percentage: number) => {
        try {
            const { res } = await sendJson(`/api/proxy/admin/feature-flags/${key}`, {
                method: 'PUT',
                body: { rollout_percentage: percentage }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('admin.featureFlags.rolloutSuccess'));
            await load();
        } catch (err) {
            console.error('Failed to update rollout', err);
            toast.error(t('admin.featureFlags.rolloutError'));
        }
    };

    const formatDate = (value?: string) => {
        if (!value) return '-';
        try {
            return new Date(value).toLocaleString();
        } catch {
            return value;
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('admin.featureFlags.title')}</CardTitle>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="space-y-3">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                ) : error ? (
                    <EmptyState
                        title={error}
                        description={t('admin.featureFlags.errorDescription')}
                        actionLabel={t('admin.featureFlags.retry')}
                        onAction={load}
                    />
                ) : flags.length === 0 ? (
                    <EmptyState title={t('admin.featureFlags.empty')} />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('admin.featureFlags.columns.key')}</TableHead>
                                <TableHead>{t('admin.featureFlags.columns.description')}</TableHead>
                                <TableHead>{t('admin.featureFlags.columns.enabled')}</TableHead>
                                <TableHead>{t('admin.featureFlags.columns.rollout')}</TableHead>
                                <TableHead>{t('admin.featureFlags.columns.updated')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {flags.map((flag) => (
                                <FlagRow
                                    key={String(flag.id)}
                                    flag={flag}
                                    onToggle={toggleFlag}
                                    onRolloutChange={updateRollout}
                                    formatDate={formatDate}
                                />
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}

interface FlagRowProps {
    flag: Flag;
    onToggle: (key: string, currentEnabled: boolean) => void;
    onRolloutChange: (key: string, percentage: number) => void;
    formatDate: (value?: string) => string;
}

function FlagRow({ flag, onToggle, onRolloutChange, formatDate }: FlagRowProps) {
    const t = useTranslations();
    const [rollout, setRollout] = React.useState<number>(flag.rollout_percentage ?? 0);

    React.useEffect(() => {
        setRollout(flag.rollout_percentage ?? 0);
    }, [flag.rollout_percentage]);

    return (
        <TableRow>
            <TableCell className="font-mono text-sm">{flag.key}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{flag.description ?? '-'}</TableCell>
            <TableCell>
                <Button variant="ghost" size="sm" onClick={() => onToggle(flag.key, flag.enabled)}>
                    {flag.enabled ? (
                        <Badge variant="success">{t('admin.featureFlags.on')}</Badge>
                    ) : (
                        <Badge variant="neutral">{t('admin.featureFlags.off')}</Badge>
                    )}
                </Button>
            </TableCell>
            <TableCell>
                <input
                    type="number"
                    min={0}
                    max={100}
                    value={rollout}
                    onChange={(e) => setRollout(Number(e.target.value))}
                    onBlur={() => {
                        const clamped = Math.min(100, Math.max(0, rollout));
                        if (clamped !== (flag.rollout_percentage ?? 0)) {
                            onRolloutChange(flag.key, clamped);
                        }
                    }}
                    className="w-20 rounded border border-input bg-background px-2 py-1 text-sm"
                />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">{formatDate(flag.updated_at)}</TableCell>
        </TableRow>
    );
}
