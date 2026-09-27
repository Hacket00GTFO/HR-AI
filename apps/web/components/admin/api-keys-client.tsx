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

const apiKeySchema = z.object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    key_prefix: z.string(),
    scopes: z.array(z.string()).or(z.record(z.string(), z.unknown())).optional().default([]),
    expires_at: z.string().optional().nullable(),
    last_used_at: z.string().optional().nullable(),
    created_at: z.string().optional(),
    revoked_at: z.string().optional().nullable()
});
type ApiKey = z.infer<typeof apiKeySchema>;

function formatDate(value?: string | null): string {
    if (!value) return '';
    try {
        const d = new Date(value);
        if (isNaN(d.getTime())) return value;
        return d.toLocaleString();
    } catch {
        return value;
    }
}

export function ApiKeysClient() {
    const t = useTranslations();
    const [keys, setKeys] = React.useState<ApiKey[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [showCreate, setShowCreate] = React.useState(false);
    const [newName, setNewName] = React.useState('');
    const [newSecret, setNewSecret] = React.useState<string | null>(null);
    const [creating, setCreating] = React.useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchJson('/api/proxy/admin/api-keys', apiKeySchema.array());
            setKeys(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const createKey = async () => {
        if (!newName.trim()) {
            toast.error(t('admin.apiKeys.errorNameRequired'));
            return;
        }
        setCreating(true);
        try {
            const { res, data } = await sendJson('/api/proxy/admin/api-keys', {
                method: 'POST',
                body: { name: newName, scopes: ['read'] }
            });
            if (!res.ok) {
                toast.error(errorMessage(data) ?? t('admin.apiKeys.error'));
                return;
            }
            const secret = (data as { secret?: string } | null)?.secret;
            if (secret) {
                setNewSecret(secret);
            }
            setNewName('');
            setShowCreate(false);
            toast.success(t('admin.apiKeys.created'));
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        } finally {
            setCreating(false);
        }
    };

    const rotateKey = async (id: number | string) => {
        try {
            const { res, data } = await sendJson(`/api/proxy/admin/api-keys/${id}/rotate`, {
                method: 'POST'
            });
            if (!res.ok) {
                toast.error(errorMessage(data) ?? t('admin.apiKeys.error'));
                return;
            }
            const secret = (data as { secret?: string } | null)?.secret;
            if (secret) {
                setNewSecret(secret);
                toast.success(t('admin.apiKeys.rotated'));
            }
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const revokeKey = async (id: number | string) => {
        try {
            const { res, data } = await sendJson(`/api/proxy/admin/api-keys/${id}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                toast.error(errorMessage(data) ?? t('admin.apiKeys.error'));
                return;
            }
            toast.success(t('admin.apiKeys.revoked'));
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const copySecret = async (secret: string) => {
        try {
            await navigator.clipboard.writeText(secret);
            toast.success(t('admin.apiKeys.copied'));
        } catch {
            toast.error(t('admin.apiKeys.copyFailed'));
        }
    };

    const scopesOf = (k: ApiKey): string[] => {
        if (Array.isArray(k.scopes)) return k.scopes as string[];
        if (k.scopes && typeof k.scopes === 'object') return Object.keys(k.scopes);
        return [];
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('admin.apiKeys.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {newSecret && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
                        <div className="flex items-center justify-between gap-2">
                            <div className="space-y-1">
                                <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                                    {t('admin.apiKeys.secretCreated')}
                                </p>
                                <code className="block break-all rounded bg-amber-100 px-2 py-1 text-sm dark:bg-amber-900">
                                    {newSecret}
                                </code>
                                <p className="text-xs text-amber-800 dark:text-amber-200">
                                    {t('admin.apiKeys.secretWarning')}
                                </p>
                            </div>
                            <div className="flex gap-2">
                                <Button variant="secondary" onClick={() => copySecret(newSecret)}>
                                    {t('admin.apiKeys.copy')}
                                </Button>
                                <Button variant="ghost" onClick={() => setNewSecret(null)}>
                                    {t('admin.apiKeys.dismiss')}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">{t('admin.apiKeys.description')}</p>
                    {!showCreate && (
                        <Button variant="primary" onClick={() => setShowCreate(true)}>
                            {t('admin.apiKeys.create')}
                        </Button>
                    )}
                </div>

                {showCreate && (
                    <div className="flex items-end gap-2 rounded-md border p-4">
                        <div className="flex-1 space-y-1">
                            <label className="text-sm font-medium">{t('admin.apiKeys.nameLabel')}</label>
                            <Input
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder={t('admin.apiKeys.namePlaceholder')}
                            />
                        </div>
                        <Button variant="primary" onClick={createKey} disabled={creating}>
                            {creating ? t('admin.apiKeys.creating') : t('admin.apiKeys.create')}
                        </Button>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setShowCreate(false);
                                setNewName('');
                            }}
                        >
                            {t('admin.apiKeys.cancel')}
                        </Button>
                    </div>
                )}

                {loading ? (
                    <div className="space-y-2">
                        {[0, 1, 2].map((i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                ) : error ? (
                    <EmptyState
                        title={t('admin.apiKeys.errorTitle')}
                        description={error}
                        actionLabel={t('admin.apiKeys.retry')}
                        onAction={load}
                    />
                ) : keys.length === 0 ? (
                    <EmptyState
                        title={t('admin.apiKeys.emptyTitle')}
                        description={t('admin.apiKeys.emptyDescription')}
                        actionLabel={t('admin.apiKeys.create')}
                        onAction={() => setShowCreate(true)}
                    />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('admin.apiKeys.colName')}</TableHead>
                                <TableHead>{t('admin.apiKeys.colPrefix')}</TableHead>
                                <TableHead>{t('admin.apiKeys.colScopes')}</TableHead>
                                <TableHead>{t('admin.apiKeys.colStatus')}</TableHead>
                                <TableHead>{t('admin.apiKeys.colExpires')}</TableHead>
                                <TableHead>{t('admin.apiKeys.colLastUsed')}</TableHead>
                                <TableHead className="text-right">{t('admin.apiKeys.colActions')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {keys.map((k) => {
                                const revoked = !!k.revoked_at;
                                return (
                                    <TableRow key={String(k.id)}>
                                        <TableCell className="font-medium">{k.name}</TableCell>
                                        <TableCell>
                                            <code className="text-sm">{k.key_prefix}...</code>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-1">
                                                {scopesOf(k).map((s) => (
                                                    <Badge key={s} variant="neutral">
                                                        {s}
                                                    </Badge>
                                                ))}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            {revoked ? (
                                                <Badge variant="danger">{t('admin.apiKeys.statusRevoked')}</Badge>
                                            ) : (
                                                <Badge variant="success">{t('admin.apiKeys.statusActive')}</Badge>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            {k.expires_at ? formatDate(k.expires_at) : t('admin.apiKeys.noExpiry')}
                                        </TableCell>
                                        <TableCell>
                                            {k.last_used_at ? formatDate(k.last_used_at) : t('admin.apiKeys.never')}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex justify-end gap-2">
                                                <Button
                                                    variant="secondary"
                                                    onClick={() => rotateKey(k.id)}
                                                    disabled={revoked}
                                                >
                                                    {t('admin.apiKeys.rotate')}
                                                </Button>
                                                <Button
                                                    variant="danger"
                                                    onClick={() => revokeKey(k.id)}
                                                    disabled={revoked}
                                                >
                                                    {t('admin.apiKeys.revoke')}
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}
