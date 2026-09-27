'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarMinus, SearchX } from 'lucide-react';
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
import {
    leaveBalancesResponseSchema,
    leaveRequestsResponseSchema,
    leaveTypesResponseSchema,
    type LeaveBalance,
    type LeaveRequest,
    type LeaveType
} from './schemas';
import { isCancellable, leaveDaysBetween, isoToday } from './lib';

type LoadState = 'loading' | 'error' | 'done';

// Ausencias: my leave balances, a request form and my request history.
// Upstream: GET /v1/leave/{types,balances,requests}, POST /v1/leave/requests,
// PUT /v1/leave/requests/:id/cancel — all via /api/proxy/*.
export function LeaveClient() {
    const t = useTranslations('portal.leave');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [types, setTypes] = React.useState<LeaveType[]>([]);
    const [balances, setBalances] = React.useState<LeaveBalance[]>([]);
    const [requests, setRequests] = React.useState<LeaveRequest[]>([]);
    const [state, setState] = React.useState<LoadState>('loading');
    const [cancelling, setCancelling] = React.useState<number | null>(null);

    const schema = React.useMemo(
        () =>
            z
                .object({
                    leaveTypeId: z.coerce.number().int().positive(t('errors.typeRequired')),
                    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t('errors.invalidDate')),
                    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t('errors.invalidDate')),
                    reason: z.string().trim().max(2000, t('errors.reasonTooLong'))
                })
                .refine((v) => leaveDaysBetween(v.startDate, v.endDate) !== null, {
                    path: ['endDate'],
                    message: t('errors.endBeforeStart')
                }),
        [t]
    );
    type FormInput = z.input<typeof schema>;
    type Values = z.output<typeof schema>;

    const {
        register,
        handleSubmit,
        watch,
        reset,
        formState: { errors, isSubmitting }
    } = useForm<FormInput, unknown, Values>({
        resolver: zodResolver(schema),
        defaultValues: { leaveTypeId: undefined, startDate: isoToday(), endDate: isoToday(), reason: '' }
    });

    const startDate = watch('startDate');
    const endDate = watch('endDate');
    const requestedDays = leaveDaysBetween(startDate ?? '', endDate ?? '');

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const [t, b, r] = await Promise.all([
                fetchJson('/api/proxy/leave/types', leaveTypesResponseSchema),
                fetchJson('/api/proxy/leave/balances', leaveBalancesResponseSchema),
                fetchJson('/api/proxy/leave/requests', leaveRequestsResponseSchema)
            ]);
            setTypes(t.types);
            setBalances(b.balances);
            setRequests(r.requests);
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const typeName = (id: number) => types.find((lt) => lt.id === id)?.name ?? `#${id}`;

    const onSubmit = async (values: Values) => {
        const { res, data } = await sendJson('/api/proxy/leave/requests', {
            method: 'POST',
            body: {
                leaveTypeId: values.leaveTypeId,
                startDate: values.startDate,
                endDate: values.endDate,
                ...(values.reason ? { reason: values.reason } : {})
            }
        });
        if (res.ok) {
            toast.success(t('requestOk'));
            reset({ leaveTypeId: undefined, startDate: isoToday(), endDate: isoToday(), reason: '' });
            load();
            return;
        }
        if (res.status === 409) toast.error(t('errors.conflict'));
        else toast.error(errorMessage(data) ?? t('errors.generic'));
    };

    const cancel = async (id: number) => {
        setCancelling(id);
        try {
            const { res } = await sendJson(`/api/proxy/leave/requests/${id}/cancel`, { method: 'PUT' });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('cancelOk'));
            load();
        } catch {
            toast.error(t('errors.generic'));
        } finally {
            setCancelling(null);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <header>
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
            </header>

            {/* Balances */}
            <section aria-labelledby="leave-balances">
                <h2 id="leave-balances" className="mb-3 font-display text-lg font-semibold">
                    {t('balancesTitle')}
                </h2>
                {state === 'loading' ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {[0, 1].map((i) => (
                            <Skeleton key={i} className="h-24 rounded-xl" />
                        ))}
                    </div>
                ) : state === 'error' ? (
                    <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
                ) : balances.length === 0 ? (
                    <EmptyState icon={<CalendarMinus />} title={t('balancesEmpty')} />
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {balances.map((b) => (
                            <Card key={`${b.leaveTypeId}-${b.year}`}>
                                <CardContent className="flex flex-col gap-1 py-4">
                                    <p className="text-sm font-medium">{typeName(b.leaveTypeId)}</p>
                                    <p className="font-display text-2xl font-bold">
                                        {t('daysLeft', { days: b.available })}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {t('balanceDetail', {
                                            entitled: b.entitled,
                                            used: b.used,
                                            carried: b.carried,
                                            year: b.year
                                        })}
                                    </p>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </section>

            {/* Request form */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">{t('formTitle')}</CardTitle>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                        <FormField label={t('form.type')} id="leave-type" required error={errors.leaveTypeId?.message}>
                            <Select {...register('leaveTypeId')} disabled={types.length === 0}>
                                <option value="">{t('form.typePlaceholder')}</option>
                                {types.map((lt) => (
                                    <option key={lt.id} value={lt.id}>
                                        {lt.name}
                                    </option>
                                ))}
                            </Select>
                        </FormField>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <FormField
                                label={t('form.startDate')}
                                id="leave-start"
                                required
                                error={errors.startDate?.message}
                            >
                                <Input type="date" {...register('startDate')} />
                            </FormField>
                            <FormField
                                label={t('form.endDate')}
                                id="leave-end"
                                required
                                error={errors.endDate?.message}
                            >
                                <Input type="date" {...register('endDate')} />
                            </FormField>
                        </div>
                        {requestedDays !== null && (
                            <p className="text-sm text-muted-foreground" role="status">
                                {t('daysRequested', { days: requestedDays })}
                            </p>
                        )}
                        <FormField label={t('form.reason')} id="leave-reason" error={errors.reason?.message}>
                            <Textarea rows={3} maxLength={2000} {...register('reason')} />
                        </FormField>
                        <div>
                            <Button type="submit" loading={isSubmitting} disabled={types.length === 0}>
                                {t('form.submit')}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>

            {/* My requests */}
            <section aria-labelledby="leave-requests">
                <h2 id="leave-requests" className="mb-3 font-display text-lg font-semibold">
                    {t('requestsTitle')}
                </h2>
                {state === 'loading' ? (
                    <div aria-busy="true" className="flex flex-col gap-2">
                        {[0, 1, 2].map((i) => (
                            <Skeleton key={i} className="h-14 rounded-lg" />
                        ))}
                    </div>
                ) : state === 'error' ? null : requests.length === 0 ? (
                    <EmptyState icon={<CalendarMinus />} title={t('requestsEmpty')} />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {requests.map((r) => (
                            <li
                                key={r.id}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                            >
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{typeName(r.leaveTypeId)}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {formatDate(r.startDate, locale)} – {formatDate(r.endDate, locale)}
                                        {' · '}
                                        {t('daysRequested', { days: r.days })}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <PortalStatusBadge status={r.status} />
                                    {isCancellable(r) && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            loading={cancelling === r.id}
                                            onClick={() => cancel(r.id)}
                                            className="text-danger-500"
                                        >
                                            {t('cancel')}
                                        </Button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
