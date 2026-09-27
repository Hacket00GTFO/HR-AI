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
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { z } from 'zod';

const workflowSchema = z.object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    entity_type: z.string(),
    rules: z.record(z.string(), z.unknown()).or(z.string()).optional().default({}),
    active: z.boolean().optional().default(true),
    created_at: z.string().optional()
});
type Workflow = z.infer<typeof workflowSchema>;

const requestSchema = z.object({
    id: z.union([z.number(), z.string()]),
    workflow_id: z.number(),
    entity_type: z.string(),
    entity_id: z.number(),
    requested_by: z.number().optional().nullable(),
    status: z.string().optional().default('pending'),
    rejection_reason: z.string().optional().nullable(),
    created_at: z.string().optional(),
    resolved_at: z.string().optional().nullable()
});
type ApprovalRequest = z.infer<typeof requestSchema>;

export function ApprovalWorkflowsClient() {
    const t = useTranslations();
    const [workflows, setWorkflows] = React.useState<Workflow[]>([]);
    const [pending, setPending] = React.useState<ApprovalRequest[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [showCreate, setShowCreate] = React.useState(false);
    const [newName, setNewName] = React.useState('');
    const [newEntityType, setNewEntityType] = React.useState('');
    const [newRules, setNewRules] = React.useState('{}');
    const [creating, setCreating] = React.useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [wfRes, pendRes] = await Promise.all([
                fetchJson('/api/proxy/admin/approvals/workflows', workflowSchema.array()),
                fetchJson('/api/proxy/admin/approvals/pending', requestSchema.array())
            ]);
            setWorkflows(wfRes);
            setPending(pendRes);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load data');
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const createWorkflow = async () => {
        setCreating(true);
        try {
            const rules = JSON.parse(newRules);
            const { res, data } = await sendJson('/api/proxy/admin/approvals/workflows', {
                method: 'POST',
                body: { name: newName, entity_type: newEntityType, rules }
            });
            if (!res.ok) throw new Error(errorMessage(data) ?? `HTTP ${res.status}`);
            toast.success(t('admin.approvals.workflowCreated'));
            setNewName('');
            setNewEntityType('');
            setNewRules('{}');
            setShowCreate(false);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.approvals.createFailed'));
        } finally {
            setCreating(false);
        }
    };

    const approveRequest = async (id: number | string) => {
        try {
            const { res, data } = await sendJson(`/api/proxy/admin/approvals/${id}/approve`, { method: 'POST' });
            if (!res.ok) throw new Error(errorMessage(data) ?? `HTTP ${res.status}`);
            toast.success(t('admin.approvals.requestApproved'));
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.approvals.actionFailed'));
        }
    };

    const rejectRequest = async (id: number | string) => {
        try {
            const { res, data } = await sendJson(`/api/proxy/admin/approvals/${id}/reject`, {
                method: 'POST',
                body: { reason: 'Rejected by admin' }
            });
            if (!res.ok) throw new Error(errorMessage(data) ?? `HTTP ${res.status}`);
            toast.success(t('admin.approvals.requestRejected'));
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.approvals.actionFailed'));
        }
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (error) {
        return (
            <EmptyState
                title={t('admin.approvals.errorTitle')}
                description={error}
                actionLabel={t('admin.approvals.retry')}
                onAction={() => load()}
            />
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold">{t('admin.approvals.title')}</h1>
                <Button variant="primary" onClick={() => setShowCreate((v) => !v)}>
                    {t('admin.approvals.createWorkflow')}
                </Button>
            </div>

            {showCreate && (
                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.approvals.newWorkflow')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('admin.approvals.name')}</label>
                            <Input
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder={t('admin.approvals.namePlaceholder')}
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('admin.approvals.entityType')}</label>
                            <Input
                                value={newEntityType}
                                onChange={(e) => setNewEntityType(e.target.value)}
                                placeholder={t('admin.approvals.entityTypePlaceholder')}
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('admin.approvals.rules')}</label>
                            <textarea
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                                rows={6}
                                value={newRules}
                                onChange={(e) => setNewRules(e.target.value)}
                                placeholder="{}"
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button variant="primary" onClick={createWorkflow} disabled={creating}>
                                {creating ? t('admin.approvals.creating') : t('admin.approvals.create')}
                            </Button>
                            <Button variant="secondary" onClick={() => setShowCreate(false)}>
                                {t('admin.approvals.cancel')}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.approvals.workflows')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {workflows.length === 0 ? (
                        <EmptyState title={t('admin.approvals.noWorkflows')} />
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('admin.approvals.name')}</TableHead>
                                    <TableHead>{t('admin.approvals.entityType')}</TableHead>
                                    <TableHead>{t('admin.approvals.status')}</TableHead>
                                    <TableHead>{t('admin.approvals.created')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {workflows.map((wf) => (
                                    <TableRow key={String(wf.id)}>
                                        <TableCell>{wf.name}</TableCell>
                                        <TableCell>{wf.entity_type}</TableCell>
                                        <TableCell>
                                            <Badge variant={wf.active ? 'success' : 'neutral'}>
                                                {wf.active
                                                    ? t('admin.approvals.active')
                                                    : t('admin.approvals.inactive')}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>{wf.created_at ?? '-'}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.approvals.pendingRequests')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {pending.length === 0 ? (
                        <EmptyState title={t('admin.approvals.noPending')} />
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('admin.approvals.entityType')}</TableHead>
                                    <TableHead>{t('admin.approvals.entityId')}</TableHead>
                                    <TableHead>{t('admin.approvals.status')}</TableHead>
                                    <TableHead>{t('admin.approvals.requestedBy')}</TableHead>
                                    <TableHead>{t('admin.approvals.date')}</TableHead>
                                    <TableHead>{t('admin.approvals.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {pending.map((req) => (
                                    <TableRow key={String(req.id)}>
                                        <TableCell>{req.entity_type}</TableCell>
                                        <TableCell>{req.entity_id}</TableCell>
                                        <TableCell>
                                            <Badge variant={req.status === 'pending' ? 'warning' : 'info'}>
                                                {req.status}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>{req.requested_by ?? '-'}</TableCell>
                                        <TableCell>{req.created_at ?? '-'}</TableCell>
                                        <TableCell>
                                            <div className="flex gap-2">
                                                <Button variant="primary" onClick={() => approveRequest(req.id)}>
                                                    {t('admin.approvals.approve')}
                                                </Button>
                                                <Button variant="danger" onClick={() => rejectRequest(req.id)}>
                                                    {t('admin.approvals.reject')}
                                                </Button>
                                            </div>
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
