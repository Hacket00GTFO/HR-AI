'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, SearchX, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { fetchJson, sendJson, errorMessage } from '@/lib/http';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { PortalStatusBadge } from './portal-status-badge';
import { ticketListResponseSchema, type Ticket as TicketT } from './schemas';
import { normalizeTickets, ticketCreatedAt, ticketTitle } from './lib';

const CATEGORIES = ['general', 'payroll', 'benefits', 'it', 'workplace', 'other'] as const;

// Tickets RH — own HR-service tickets.
// NOTE: upstream GET/POST /v1/tickets is not deployed yet (no gateway route;
// the monolith 404s). Built against the documented contract — see
// components/portal/schemas.ts.
export function TicketsClient() {
    const t = useTranslations('portal.tickets');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [tickets, setTickets] = React.useState<TicketT[]>([]);
    const [state, setState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [formOpen, setFormOpen] = React.useState(false);

    const schema = React.useMemo(
        () =>
            z.object({
                category: z.enum(CATEGORIES, { message: t('errors.categoryRequired') }),
                subject: z.string().trim().min(3, t('errors.subjectShort')).max(200),
                description: z.string().trim().min(10, t('errors.descriptionShort')).max(4000)
            }),
        [t]
    );
    type Values = z.infer<typeof schema>;

    const {
        register,
        handleSubmit,
        reset,
        formState: { errors, isSubmitting }
    } = useForm<Values>({
        resolver: zodResolver(schema),
        defaultValues: { category: 'general', subject: '', description: '' }
    });

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const data = await fetchJson('/api/proxy/tickets', ticketListResponseSchema);
            setTickets(normalizeTickets(data));
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const onSubmit = async (values: Values) => {
        const { res, data } = await sendJson('/api/proxy/tickets', { method: 'POST', body: values });
        if (res.ok) {
            toast.success(t('createOk'));
            reset({ category: 'general', subject: '', description: '' });
            setFormOpen(false);
            load();
            return;
        }
        toast.error(errorMessage(data) ?? t('errors.generic'));
    };

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <header>
                    <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
                </header>
                <Button onClick={() => setFormOpen((o) => !o)} variant={formOpen ? 'secondary' : 'primary'}>
                    <Plus aria-hidden="true" />
                    {formOpen ? tCommon('cancel') : t('new')}
                </Button>
            </div>

            {formOpen && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">{t('formTitle')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                            <FormField
                                label={t('form.category')}
                                id="ticket-category"
                                required
                                error={errors.category?.message}
                            >
                                <Select {...register('category')}>
                                    {CATEGORIES.map((c) => (
                                        <option key={c} value={c}>
                                            {t(`categories.${c}`)}
                                        </option>
                                    ))}
                                </Select>
                            </FormField>
                            <FormField
                                label={t('form.subject')}
                                id="ticket-subject"
                                required
                                error={errors.subject?.message}
                            >
                                <Input maxLength={200} {...register('subject')} />
                            </FormField>
                            <FormField
                                label={t('form.description')}
                                id="ticket-description"
                                required
                                error={errors.description?.message}
                            >
                                <Textarea rows={4} maxLength={4000} {...register('description')} />
                            </FormField>
                            <div>
                                <Button type="submit" loading={isSubmitting}>
                                    {t('form.submit')}
                                </Button>
                            </div>
                        </form>
                    </CardContent>
                </Card>
            )}

            {state === 'loading' ? (
                <div aria-busy="true" className="flex flex-col gap-2">
                    {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-16 rounded-lg" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : tickets.length === 0 ? (
                <EmptyState icon={<Ticket />} title={t('empty')} description={t('emptyHint')} />
            ) : (
                <ul className="flex flex-col gap-2">
                    {tickets.map((tk) => (
                        <li key={String(tk.id)}>
                            <Link
                                href={`/portal/tickets/${String(tk.id)}`}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-muted"
                            >
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{ticketTitle(tk)}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {tk.category &&
                                            (CATEGORIES.includes(tk.category as (typeof CATEGORIES)[number])
                                                ? t(`categories.${tk.category as (typeof CATEGORIES)[number]}`)
                                                : tk.category)}
                                        {ticketCreatedAt(tk) ? ` · ${formatDate(ticketCreatedAt(tk), locale)}` : ''}
                                    </p>
                                </div>
                                <PortalStatusBadge status={tk.status} />
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
