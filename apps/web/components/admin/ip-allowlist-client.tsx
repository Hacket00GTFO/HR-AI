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

const entrySchema = z.object({
    id: z.union([z.number(), z.string()]),
    ip_cidr: z.string(),
    label: z.string().optional().nullable(),
    applies_to: z.string().optional().default('admin'),
    created_at: z.string().optional()
});
type Entry = z.infer<typeof entrySchema>;

export function IpAllowlistClient() {
    const t = useTranslations();
    const [entries, setEntries] = React.useState<Entry[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [showCreate, setShowCreate] = React.useState(false);
    const [newIpCidr, setNewIpCidr] = React.useState('');
    const [newLabel, setNewLabel] = React.useState('');
    const [newAppliesTo, setNewAppliesTo] = React.useState('admin');

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchJson('/api/proxy/admin/ip-allowlist', entrySchema.array());
            setEntries(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load entries');
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    async function createEntry() {
        if (!newIpCidr.trim()) {
            toast.error(t('admin.ipAllowlist.errorIpRequired'));
            return;
        }
        try {
            const { res, data } = await sendJson('/api/proxy/admin/ip-allowlist', {
                method: 'POST',
                body: {
                    ip_cidr: newIpCidr,
                    label: newLabel,
                    applies_to: newAppliesTo
                }
            });
            if (!res.ok) throw new Error(errorMessage(data) ?? `HTTP ${res.status}`);
            toast.success(t('admin.ipAllowlist.created'));
            setNewIpCidr('');
            setNewLabel('');
            setNewAppliesTo('admin');
            setShowCreate(false);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.ipAllowlist.errorCreate'));
        }
    }

    async function deleteEntry(id: number | string) {
        try {
            const { res, data } = await sendJson(`/api/proxy/admin/ip-allowlist/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(errorMessage(data) ?? `HTTP ${res.status}`);
            toast.success(t('admin.ipAllowlist.deleted'));
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.ipAllowlist.errorDelete'));
        }
    }

    const appliesToVariant = (
        appliesTo: string
    ): 'default' | 'neutral' | 'success' | 'warning' | 'info' | 'danger' | 'coral' => {
        switch (appliesTo) {
            case 'admin':
                return 'info';
            case 'all':
                return 'success';
            case 'api':
                return 'coral';
            default:
                return 'default';
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('admin.ipAllowlist.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
                    {t('admin.ipAllowlist.infoBanner')}
                </div>

                <div className="flex items-center justify-between">
                    <Button variant="primary" onClick={() => setShowCreate((v) => !v)}>
                        {t('admin.ipAllowlist.create')}
                    </Button>
                </div>

                {showCreate && (
                    <div className="space-y-3 rounded-md border p-4">
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="space-y-1">
                                <label className="text-sm font-medium">{t('admin.ipAllowlist.ipCidr')}</label>
                                <Input
                                    value={newIpCidr}
                                    onChange={(e) => setNewIpCidr(e.target.value)}
                                    placeholder="192.168.1.0/24"
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="text-sm font-medium">{t('admin.ipAllowlist.label')}</label>
                                <Input
                                    value={newLabel}
                                    onChange={(e) => setNewLabel(e.target.value)}
                                    placeholder={t('admin.ipAllowlist.labelPlaceholder')}
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="text-sm font-medium">{t('admin.ipAllowlist.appliesTo')}</label>
                                <select
                                    value={newAppliesTo}
                                    onChange={(e) => setNewAppliesTo(e.target.value)}
                                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                                >
                                    <option value="admin">admin</option>
                                    <option value="all">all</option>
                                    <option value="api">api</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <Button variant="primary" onClick={createEntry}>
                                {t('admin.ipAllowlist.add')}
                            </Button>
                            <Button variant="secondary" onClick={() => setShowCreate(false)}>
                                {t('admin.ipAllowlist.cancel')}
                            </Button>
                        </div>
                    </div>
                )}

                {loading ? (
                    <div className="space-y-2">
                        {Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="flex items-center gap-4">
                                <Skeleton className="h-10 w-full" />
                            </div>
                        ))}
                    </div>
                ) : error ? (
                    <EmptyState
                        title={t('admin.ipAllowlist.errorTitle')}
                        description={error}
                        actionLabel={t('admin.ipAllowlist.retry')}
                        onAction={load}
                    />
                ) : entries.length === 0 ? (
                    <EmptyState
                        title={t('admin.ipAllowlist.emptyTitle')}
                        description={t('admin.ipAllowlist.emptyDescription')}
                    />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('admin.ipAllowlist.ipCidr')}</TableHead>
                                <TableHead>{t('admin.ipAllowlist.label')}</TableHead>
                                <TableHead>{t('admin.ipAllowlist.appliesTo')}</TableHead>
                                <TableHead>{t('admin.ipAllowlist.created')}</TableHead>
                                <TableHead className="text-right">{t('admin.ipAllowlist.actions')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {entries.map((entry) => (
                                <TableRow key={String(entry.id)}>
                                    <TableCell className="font-mono">{entry.ip_cidr}</TableCell>
                                    <TableCell>{entry.label || '-'}</TableCell>
                                    <TableCell>
                                        <Badge variant={appliesToVariant(entry.applies_to ?? 'admin')}>
                                            {entry.applies_to ?? 'admin'}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>{entry.created_at ?? '-'}</TableCell>
                                    <TableCell className="text-right">
                                        <Button variant="danger" onClick={() => deleteEntry(entry.id)}>
                                            {t('admin.ipAllowlist.delete')}
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}
