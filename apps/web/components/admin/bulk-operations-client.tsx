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

const operationSchema = z.object({
    id: z.union([z.number(), z.string()]),
    operation_type: z.string(),
    entity_type: z.string(),
    total_records: z.number().optional().default(0),
    processed_records: z.number().optional().default(0),
    failed_records: z.number().optional().default(0),
    status: z.string().optional().default('pending'),
    result_url: z.string().optional().nullable(),
    created_at: z.string().optional(),
    completed_at: z.string().optional().nullable()
});
type Operation = z.infer<typeof operationSchema>;

const statusVariant: Record<string, 'default' | 'neutral' | 'success' | 'warning' | 'info' | 'danger' | 'coral'> = {
    pending: 'warning',
    processing: 'info',
    completed: 'success',
    failed: 'danger'
};

export function BulkOperationsClient() {
    const t = useTranslations('admin.bulk');
    const [operations, setOperations] = React.useState<Operation[]>([]);
    const [loading, setLoading] = React.useState<boolean>(true);
    const [error, setError] = React.useState<boolean>(false);
    const [selectedOp, setSelectedOp] = React.useState<string>('');

    const load = React.useCallback(async () => {
        try {
            setLoading(true);
            setError(false);
            const data = await fetchJson('/api/proxy/admin/bulk', operationSchema.array());
            setOperations(data);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const initiateImport = async () => {
        try {
            const { res } = await sendJson('/api/proxy/admin/bulk/import-candidates', {
                method: 'POST',
                body: { total_records: 0 }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('import.success'));
            load();
        } catch {
            toast.error(t('import.error'));
        }
    };

    const initiateExport = async () => {
        try {
            const { res } = await sendJson('/api/proxy/admin/bulk/export-candidates', {
                method: 'POST',
                body: { columns: ['first_name', 'last_name', 'email'] }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('export.success'));
            load();
        } catch {
            toast.error(t('export.error'));
        }
    };

    const initiateStatusChange = async () => {
        try {
            const { res } = await sendJson('/api/proxy/admin/bulk/status-change', {
                method: 'POST',
                body: { candidate_ids: [], new_status: 'active' }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('statusChange.success'));
            load();
        } catch {
            toast.error(t('statusChange.error'));
        }
    };

    const initiateArchive = async () => {
        try {
            const { res } = await sendJson('/api/proxy/admin/bulk/archive', {
                method: 'POST',
                body: { entity_type: 'candidates', ids: [] }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('archive.success'));
            load();
        } catch {
            toast.error(t('archive.error'));
        }
    };

    const initiateDelete = async () => {
        try {
            const { res } = await sendJson('/api/proxy/admin/bulk/delete', {
                method: 'POST',
                body: { entity_type: 'candidates', ids: [] }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('delete.success'));
            load();
        } catch {
            toast.error(t('delete.error'));
        }
    };

    if (loading && operations.length === 0) {
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

    if (error && operations.length === 0) {
        return <EmptyState title={t('error')} actionLabel={t('retry')} onAction={load} />;
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-semibold">{t('title')}</h1>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-sm font-medium text-muted-foreground">{t('actions')}</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-3">
                        <Button variant="primary" onClick={initiateImport}>
                            {t('import.label')}
                        </Button>
                        <Button variant="secondary" onClick={initiateExport}>
                            {t('export.label')}
                        </Button>
                        <Button variant="secondary" onClick={initiateStatusChange}>
                            {t('statusChange.label')}
                        </Button>
                        <Button variant="secondary" onClick={initiateArchive}>
                            {t('archive.label')}
                        </Button>
                        <Button variant="danger" onClick={initiateDelete}>
                            {t('delete.label')}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {operations.length === 0 ? (
                <EmptyState title={t('noOperations')} />
            ) : (
                <div className="rounded-xl border border-border bg-card shadow-sm">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('col.operation')}</TableHead>
                                <TableHead>{t('col.entityType')}</TableHead>
                                <TableHead>{t('col.total')}</TableHead>
                                <TableHead>{t('col.processed')}</TableHead>
                                <TableHead>{t('col.failed')}</TableHead>
                                <TableHead>{t('col.status')}</TableHead>
                                <TableHead>{t('col.date')}</TableHead>
                                <TableHead>{t('col.result')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {operations.map((op, i) => {
                                const variant = statusVariant[op.status] ?? 'default';
                                return (
                                    <TableRow key={`${op.id ?? i}`} data-selected={selectedOp === String(op.id)}>
                                        <TableCell className="font-medium">{op.operation_type}</TableCell>
                                        <TableCell className="text-muted-foreground">{op.entity_type}</TableCell>
                                        <TableCell className="text-muted-foreground">{op.total_records}</TableCell>
                                        <TableCell className="text-muted-foreground">{op.processed_records}</TableCell>
                                        <TableCell className="text-muted-foreground">{op.failed_records}</TableCell>
                                        <TableCell>
                                            <Badge variant={variant}>{op.status}</Badge>
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap text-muted-foreground">
                                            {op.created_at ?? '—'}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">
                                            {op.result_url ? (
                                                <a
                                                    href={op.result_url}
                                                    className="text-primary underline underline-offset-4 hover:opacity-80"
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    {t('download')}
                                                </a>
                                            ) : (
                                                '—'
                                            )}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
}
