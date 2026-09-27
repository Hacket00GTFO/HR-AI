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
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { z } from 'zod';

const policySchema = z.object({
    id: z.union([z.number(), z.string()]),
    entity_type: z.string(),
    retention_days: z.number(),
    action: z.string().optional().default('delete'),
    active: z.boolean().optional().default(true),
    created_at: z.string().optional()
});
type Policy = z.infer<typeof policySchema>;

const dsarSchema = z.object({
    id: z.union([z.number(), z.string()]),
    type: z.string(),
    email: z.string().optional().nullable(),
    candidate_id: z.number().optional().nullable(),
    status: z.string().optional().default('pending'),
    requested_by: z.string().optional().nullable(),
    result_url: z.string().optional().nullable(),
    created_at: z.string().optional(),
    completed_at: z.string().optional().nullable()
});
type Dsar = z.infer<typeof dsarSchema>;

export function DataRetentionClient() {
    const t = useTranslations();
    const [policies, setPolicies] = React.useState<Policy[]>([]);
    const [dsars, setDsars] = React.useState<Dsar[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [showCreatePolicy, setShowCreatePolicy] = React.useState(false);
    const [newEntityType, setNewEntityType] = React.useState('');
    const [newRetentionDays, setNewRetentionDays] = React.useState('');
    const [newAction, setNewAction] = React.useState('delete');

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [policiesRes, dsarsRes] = await Promise.all([
                fetchJson('/api/proxy/admin/data-retention/policies', policySchema.array()),
                fetchJson('/api/proxy/admin/data-retention/dsar', dsarSchema.array())
            ]);
            setPolicies(policiesRes);
            setDsars(dsarsRes);
        } catch (err) {
            console.error('Failed to load data retention data', err);
            setError(t('admin.dataRetention.loadError'));
        } finally {
            setLoading(false);
        }
    }, [t]);

    React.useEffect(() => {
        load();
    }, [load]);

    const createPolicy = async () => {
        if (!newEntityType || !newRetentionDays) {
            toast.error(t('admin.dataRetention.fillFields'));
            return;
        }
        const days = parseInt(newRetentionDays, 10);
        if (isNaN(days) || days <= 0) {
            toast.error(t('admin.dataRetention.invalidRetentionDays'));
            return;
        }
        try {
            const { res } = await sendJson('/api/proxy/admin/data-retention/policies', {
                method: 'POST',
                body: {
                    entity_type: newEntityType,
                    retention_days: days,
                    action: newAction,
                    active: true
                }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('admin.dataRetention.policyCreated'));
            setNewEntityType('');
            setNewRetentionDays('');
            setNewAction('delete');
            setShowCreatePolicy(false);
            await load();
        } catch (err) {
            console.error('Failed to create policy', err);
            toast.error(t('admin.dataRetention.policyCreateError'));
        }
    };

    const deletePolicy = async (id: number | string) => {
        try {
            const { res } = await sendJson(`/api/proxy/admin/data-retention/policies/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('admin.dataRetention.policyDeleted'));
            await load();
        } catch (err) {
            console.error('Failed to delete policy', err);
            toast.error(t('admin.dataRetention.policyDeleteError'));
        }
    };

    const executeDsar = async (id: number | string) => {
        try {
            const { res } = await sendJson(`/api/proxy/admin/data-retention/dsar/${id}/execute`, { method: 'POST' });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('admin.dataRetention.dsarExecuted'));
            await load();
        } catch (err) {
            console.error('Failed to execute DSAR', err);
            toast.error(t('admin.dataRetention.dsarExecuteError'));
        }
    };

    const actionBadgeVariant = (
        action: string
    ): 'default' | 'neutral' | 'success' | 'warning' | 'info' | 'danger' | 'coral' => {
        switch (action) {
            case 'delete':
                return 'danger';
            case 'anonymize':
                return 'warning';
            case 'archive':
                return 'info';
            default:
                return 'default';
        }
    };

    const statusBadgeVariant = (
        status: string
    ): 'default' | 'neutral' | 'success' | 'warning' | 'info' | 'danger' | 'coral' => {
        switch (status) {
            case 'pending':
                return 'warning';
            case 'processing':
                return 'info';
            case 'completed':
                return 'success';
            case 'rejected':
                return 'danger';
            default:
                return 'default';
        }
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-8 w-64" />
                <Card>
                    <CardHeader>
                        <CardTitle>
                            <Skeleton className="h-6 w-48" />
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>
                            <Skeleton className="h-6 w-48" />
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (error) {
        return (
            <EmptyState
                title={t('admin.dataRetention.errorTitle')}
                description={error}
                actionLabel={t('admin.dataRetention.retry')}
                onAction={load}
            />
        );
    }

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                    <CardTitle>{t('admin.dataRetention.policiesTitle')}</CardTitle>
                    <Button variant="primary" onClick={() => setShowCreatePolicy((v) => !v)}>
                        {t('admin.dataRetention.createPolicy')}
                    </Button>
                </CardHeader>
                <CardContent>
                    {showCreatePolicy && (
                        <div className="mb-4 space-y-3 rounded-lg border p-4">
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                                <div className="space-y-1">
                                    <label className="text-sm font-medium">{t('admin.dataRetention.entityType')}</label>
                                    <Input
                                        value={newEntityType}
                                        onChange={(e) => setNewEntityType(e.target.value)}
                                        placeholder="candidates"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-sm font-medium">
                                        {t('admin.dataRetention.retentionDays')}
                                    </label>
                                    <Input
                                        type="number"
                                        value={newRetentionDays}
                                        onChange={(e) => setNewRetentionDays(e.target.value)}
                                        placeholder="365"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-sm font-medium">{t('admin.dataRetention.action')}</label>
                                    <select
                                        className="w-full rounded-md border px-3 py-2 text-sm"
                                        value={newAction}
                                        onChange={(e) => setNewAction(e.target.value)}
                                    >
                                        <option value="delete">{t('admin.dataRetention.actionDelete')}</option>
                                        <option value="anonymize">{t('admin.dataRetention.actionAnonymize')}</option>
                                        <option value="archive">{t('admin.dataRetention.actionArchive')}</option>
                                    </select>
                                </div>
                                <div className="flex items-end">
                                    <Button variant="primary" onClick={createPolicy} className="w-full">
                                        {t('admin.dataRetention.create')}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {policies.length === 0 ? (
                        <EmptyState title={t('admin.dataRetention.noPolicies')} />
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('admin.dataRetention.entityType')}</TableHead>
                                    <TableHead>{t('admin.dataRetention.retentionDays')}</TableHead>
                                    <TableHead>{t('admin.dataRetention.action')}</TableHead>
                                    <TableHead>{t('admin.dataRetention.status')}</TableHead>
                                    <TableHead className="text-right">{t('admin.dataRetention.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {policies.map((policy) => (
                                    <TableRow key={policy.id}>
                                        <TableCell className="font-medium">{policy.entity_type}</TableCell>
                                        <TableCell>{policy.retention_days}</TableCell>
                                        <TableCell>
                                            <Badge variant={actionBadgeVariant(policy.action ?? 'delete')}>
                                                {policy.action ?? 'delete'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={policy.active ? 'success' : 'neutral'}>
                                                {policy.active
                                                    ? t('admin.dataRetention.active')
                                                    : t('admin.dataRetention.inactive')}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button variant="danger" onClick={() => deletePolicy(policy.id)}>
                                                {t('admin.dataRetention.delete')}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.dataRetention.dsarTitle')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {dsars.length === 0 ? (
                        <EmptyState title={t('admin.dataRetention.noDsars')} />
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('admin.dataRetention.type')}</TableHead>
                                    <TableHead>{t('admin.dataRetention.email')}</TableHead>
                                    <TableHead>{t('admin.dataRetention.candidateId')}</TableHead>
                                    <TableHead>{t('admin.dataRetention.status')}</TableHead>
                                    <TableHead>{t('admin.dataRetention.requestedBy')}</TableHead>
                                    <TableHead>{t('admin.dataRetention.date')}</TableHead>
                                    <TableHead className="text-right">{t('admin.dataRetention.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {dsars.map((dsar) => (
                                    <TableRow key={dsar.id}>
                                        <TableCell>
                                            <Badge variant="info">{dsar.type}</Badge>
                                        </TableCell>
                                        <TableCell>{dsar.email ?? '-'}</TableCell>
                                        <TableCell>{dsar.candidate_id ?? '-'}</TableCell>
                                        <TableCell>
                                            <Badge variant={statusBadgeVariant(dsar.status ?? 'pending')}>
                                                {dsar.status ?? 'pending'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>{dsar.requested_by ?? '-'}</TableCell>
                                        <TableCell>{dsar.created_at ?? '-'}</TableCell>
                                        <TableCell className="text-right">
                                            <Button
                                                variant="secondary"
                                                onClick={() => executeDsar(dsar.id)}
                                                disabled={dsar.status === 'completed' || dsar.status === 'processing'}
                                            >
                                                {t('admin.dataRetention.execute')}
                                            </Button>
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
