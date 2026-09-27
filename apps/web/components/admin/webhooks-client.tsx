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

const webhookSchema = z.object({
    id: z.union([z.number(), z.string()]),
    url: z.string(),
    description: z.string().optional().nullable(),
    events: z.array(z.string()).or(z.record(z.string(), z.unknown())).optional().default([]),
    active: z.boolean().optional().default(true),
    created_at: z.string().optional()
});
type Webhook = z.infer<typeof webhookSchema>;

const deliverySchema = z.object({
    id: z.union([z.number(), z.string()]),
    event_type: z.string().optional().nullable(),
    status_code: z.union([z.number(), z.string()]).optional().nullable(),
    attempts: z.number().optional().default(0),
    status: z.string().optional().nullable(),
    created_at: z.string().optional().nullable()
});
type Delivery = z.infer<typeof deliverySchema>;

function normalizeEvents(events: Webhook['events']): string[] {
    if (!events) return [];
    if (Array.isArray(events)) return events as string[];
    if (typeof events === 'object' && events !== null) {
        return Object.keys(events as Record<string, unknown>);
    }
    return [];
}

export function WebhooksClient() {
    const t = useTranslations();
    const [webhooks, setWebhooks] = React.useState<Webhook[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [showCreate, setShowCreate] = React.useState(false);
    const [newUrl, setNewUrl] = React.useState('');
    const [newDescription, setNewDescription] = React.useState('');
    const [newEvents, setNewEvents] = React.useState('');
    const [selectedWebhook, setSelectedWebhook] = React.useState<Webhook | null>(null);
    const [deliveries, setDeliveries] = React.useState<Delivery[]>([]);
    const [creating, setCreating] = React.useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchJson('/api/proxy/admin/webhooks', webhookSchema.array());
            setWebhooks(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load webhooks');
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const createWebhook = async () => {
        setCreating(true);
        try {
            const events = newEvents
                .split(',')
                .map((e) => e.trim())
                .filter(Boolean);
            const { res, data } = await sendJson('/api/proxy/admin/webhooks', {
                method: 'POST',
                body: { url: newUrl, description: newDescription, events }
            });
            if (!res.ok) throw new Error(errorMessage(data) ?? `HTTP ${res.status}`);
            toast.success(t('admin.webhooks.createSuccess'));
            setNewUrl('');
            setNewDescription('');
            setNewEvents('');
            setShowCreate(false);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.webhooks.createError'));
        } finally {
            setCreating(false);
        }
    };

    const deleteWebhook = async (id: Webhook['id']) => {
        try {
            const { res, data } = await sendJson(`/api/proxy/admin/webhooks/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(errorMessage(data) ?? `HTTP ${res.status}`);
            toast.success(t('admin.webhooks.deleteSuccess'));
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.webhooks.deleteError'));
        }
    };

    const viewDeliveries = async (webhook: Webhook) => {
        setSelectedWebhook(webhook);
        try {
            const data = await fetchJson(`/api/proxy/admin/webhooks/${webhook.id}/deliveries`, deliverySchema.array());
            setDeliveries(data);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.webhooks.deliveriesError'));
            setDeliveries([]);
        }
    };

    const retryDelivery = async (webhookId: Webhook['id'], deliveryId: Delivery['id']) => {
        try {
            const { res, data: retryData } = await sendJson(
                `/api/proxy/admin/webhooks/${webhookId}/deliveries/${deliveryId}/retry`,
                { method: 'POST' }
            );
            if (!res.ok) throw new Error(errorMessage(retryData) ?? `HTTP ${res.status}`);
            toast.success(t('admin.webhooks.retrySuccess'));
            const data = await fetchJson(`/api/proxy/admin/webhooks/${webhookId}/deliveries`, deliverySchema.array());
            setDeliveries(data);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.webhooks.retryError'));
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold">{t('admin.webhooks.title')}</h1>
                <Button variant="primary" onClick={() => setShowCreate((v) => !v)}>
                    {showCreate ? t('admin.webhooks.cancel') : t('admin.webhooks.create')}
                </Button>
            </div>

            {showCreate && (
                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.webhooks.createTitle')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('admin.webhooks.url')}</label>
                            <Input
                                value={newUrl}
                                onChange={(e) => setNewUrl(e.target.value)}
                                placeholder="https://example.com/webhook"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('admin.webhooks.description')}</label>
                            <Input
                                value={newDescription}
                                onChange={(e) => setNewDescription(e.target.value)}
                                placeholder={t('admin.webhooks.descriptionPlaceholder')}
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('admin.webhooks.events')}</label>
                            <Input
                                value={newEvents}
                                onChange={(e) => setNewEvents(e.target.value)}
                                placeholder="event.one, event.two"
                            />
                        </div>
                        <Button variant="primary" onClick={createWebhook} disabled={creating || !newUrl}>
                            {creating ? t('admin.webhooks.creating') : t('admin.webhooks.create')}
                        </Button>
                    </CardContent>
                </Card>
            )}

            {loading ? (
                <Card>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('admin.webhooks.url')}</TableHead>
                                    <TableHead>{t('admin.webhooks.description')}</TableHead>
                                    <TableHead>{t('admin.webhooks.events')}</TableHead>
                                    <TableHead>{t('admin.webhooks.status')}</TableHead>
                                    <TableHead>{t('admin.webhooks.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {[...Array(3)].map((_, i) => (
                                    <TableRow key={i}>
                                        <TableCell>
                                            <Skeleton className="h-4 w-full" />
                                        </TableCell>
                                        <TableCell>
                                            <Skeleton className="h-4 w-full" />
                                        </TableCell>
                                        <TableCell>
                                            <Skeleton className="h-4 w-full" />
                                        </TableCell>
                                        <TableCell>
                                            <Skeleton className="h-4 w-full" />
                                        </TableCell>
                                        <TableCell>
                                            <Skeleton className="h-4 w-full" />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            ) : error ? (
                <EmptyState
                    title={t('admin.webhooks.errorTitle')}
                    description={error}
                    actionLabel={t('admin.webhooks.retry')}
                    onAction={load}
                />
            ) : webhooks.length === 0 ? (
                <EmptyState
                    title={t('admin.webhooks.emptyTitle')}
                    description={t('admin.webhooks.emptyDescription')}
                    actionLabel={t('admin.webhooks.create')}
                    onAction={() => setShowCreate(true)}
                />
            ) : (
                <Card>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('admin.webhooks.url')}</TableHead>
                                    <TableHead>{t('admin.webhooks.description')}</TableHead>
                                    <TableHead>{t('admin.webhooks.events')}</TableHead>
                                    <TableHead>{t('admin.webhooks.status')}</TableHead>
                                    <TableHead>{t('admin.webhooks.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {webhooks.map((webhook) => (
                                    <TableRow key={String(webhook.id)}>
                                        <TableCell className="font-mono text-sm">{webhook.url}</TableCell>
                                        <TableCell className="text-sm">{webhook.description ?? '-'}</TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-1">
                                                {normalizeEvents(webhook.events).map((event) => (
                                                    <Badge key={event} variant="info">
                                                        {event}
                                                    </Badge>
                                                ))}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={webhook.active ? 'success' : 'neutral'}>
                                                {webhook.active
                                                    ? t('admin.webhooks.active')
                                                    : t('admin.webhooks.inactive')}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex gap-2">
                                                <Button variant="secondary" onClick={() => viewDeliveries(webhook)}>
                                                    {t('admin.webhooks.viewDeliveries')}
                                                </Button>
                                                <Button variant="danger" onClick={() => deleteWebhook(webhook.id)}>
                                                    {t('admin.webhooks.delete')}
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {selectedWebhook && (
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <CardTitle>{t('admin.webhooks.deliveriesTitle')}</CardTitle>
                            <Button variant="ghost" onClick={() => setSelectedWebhook(null)}>
                                {t('admin.webhooks.back')}
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('admin.webhooks.eventType')}</TableHead>
                                    <TableHead>{t('admin.webhooks.statusCode')}</TableHead>
                                    <TableHead>{t('admin.webhooks.attempts')}</TableHead>
                                    <TableHead>{t('admin.webhooks.status')}</TableHead>
                                    <TableHead>{t('admin.webhooks.date')}</TableHead>
                                    <TableHead>{t('admin.webhooks.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {deliveries.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                                            {t('admin.webhooks.noDeliveries')}
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    deliveries.map((delivery) => (
                                        <TableRow key={String(delivery.id)}>
                                            <TableCell className="font-mono text-sm">
                                                {delivery.event_type ?? '-'}
                                            </TableCell>
                                            <TableCell className="text-sm">{delivery.status_code ?? '-'}</TableCell>
                                            <TableCell className="text-sm">{delivery.attempts}</TableCell>
                                            <TableCell>
                                                <Badge
                                                    variant={
                                                        delivery.status === 'success'
                                                            ? 'success'
                                                            : delivery.status === 'failed'
                                                              ? 'danger'
                                                              : 'warning'
                                                    }
                                                >
                                                    {delivery.status ?? '-'}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-sm">{delivery.created_at ?? '-'}</TableCell>
                                            <TableCell>
                                                <Button
                                                    variant="secondary"
                                                    onClick={() => retryDelivery(selectedWebhook.id, delivery.id)}
                                                >
                                                    {t('admin.webhooks.retry')}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
