'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Receipt, SearchX, Trash2 } from 'lucide-react';
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
import { PortalStatusBadge } from './portal-status-badge';
import { expenseListResponseSchema, type ExpenseReport } from './schemas';
import {
    expenseReportDisplayTotal,
    expenseReportTotal,
    isoToday,
    normalizeExpenseReports,
    reportDate,
    reportTitle
} from './lib';

const CATEGORIES = ['transport', 'lodging', 'meals', 'supplies', 'other'] as const;

// Viáticos — expense reports with dynamic line items.
// NOTE: GET/POST /v1/expenses is not deployed yet upstream (gateway has no
// 'expenses' route → monolith 404). Built against the documented contract:
// POST body { title, currency, items: [{date, category, description, amount}] }.
export function ExpensesClient() {
    const t = useTranslations('portal.expenses');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [reports, setReports] = React.useState<ExpenseReport[]>([]);
    const [state, setState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [formOpen, setFormOpen] = React.useState(false);

    const schema = React.useMemo(
        () =>
            z.object({
                title: z.string().trim().min(3, t('errors.titleShort')).max(200),
                items: z
                    .array(
                        z.object({
                            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t('errors.invalidDate')),
                            category: z.enum(CATEGORIES, { message: t('errors.categoryRequired') }),
                            description: z.string().trim().min(1, t('errors.descriptionRequired')).max(500),
                            amount: z.coerce.number().positive(t('errors.amountPositive')).max(1_000_000)
                        })
                    )
                    .min(1, t('errors.itemRequired'))
            }),
        [t]
    );
    type FormInput = z.input<typeof schema>;
    type Values = z.output<typeof schema>;

    const {
        register,
        control,
        handleSubmit,
        watch,
        reset,
        formState: { errors, isSubmitting }
    } = useForm<FormInput, unknown, Values>({
        resolver: zodResolver(schema),
        defaultValues: {
            title: '',
            items: [{ date: isoToday(), category: 'transport', description: '', amount: undefined }]
        }
    });
    const { fields, append, remove } = useFieldArray({ control, name: 'items' });
    const watchedItems = watch('items');
    const total = expenseReportTotal(
        (watchedItems ?? []).map((i) => ({ amount: typeof i?.amount === 'number' ? i.amount : Number(i?.amount) || 0 }))
    );

    const money = (n: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'MXN' }).format(n);

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const data = await fetchJson('/api/proxy/expenses', expenseListResponseSchema);
            setReports(normalizeExpenseReports(data));
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const onSubmit = async (values: Values) => {
        const { res, data } = await sendJson('/api/proxy/expenses', {
            method: 'POST',
            body: { title: values.title, currency: 'MXN', items: values.items }
        });
        if (res.ok) {
            toast.success(t('submitOk'));
            reset({
                title: '',
                items: [{ date: isoToday(), category: 'transport', description: '', amount: undefined }]
            });
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
                                label={t('form.reportTitle')}
                                id="exp-title"
                                required
                                error={errors.title?.message}
                            >
                                <Input maxLength={200} {...register('title')} />
                            </FormField>

                            <fieldset className="flex flex-col gap-3">
                                <legend className="text-sm font-medium">{t('form.items')}</legend>
                                {errors.items?.root?.message && (
                                    <p role="alert" className="text-xs font-medium text-danger-500">
                                        {errors.items.root.message}
                                    </p>
                                )}
                                {fields.map((field, i) => (
                                    <div
                                        key={field.id}
                                        className="grid grid-cols-2 items-start gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_2fr_1fr_auto]"
                                    >
                                        <FormField
                                            label={t('form.itemDate')}
                                            id={`exp-item-${i}-date`}
                                            required
                                            error={errors.items?.[i]?.date?.message}
                                        >
                                            <Input type="date" {...register(`items.${i}.date`)} />
                                        </FormField>
                                        <FormField
                                            label={t('form.itemCategory')}
                                            id={`exp-item-${i}-category`}
                                            required
                                            error={errors.items?.[i]?.category?.message}
                                        >
                                            <Select {...register(`items.${i}.category`)}>
                                                {CATEGORIES.map((c) => (
                                                    <option key={c} value={c}>
                                                        {t(`categories.${c}`)}
                                                    </option>
                                                ))}
                                            </Select>
                                        </FormField>
                                        <FormField
                                            label={t('form.itemDescription')}
                                            id={`exp-item-${i}-description`}
                                            required
                                            error={errors.items?.[i]?.description?.message}
                                        >
                                            <Input maxLength={500} {...register(`items.${i}.description`)} />
                                        </FormField>
                                        <FormField
                                            label={t('form.itemAmount')}
                                            id={`exp-item-${i}-amount`}
                                            required
                                            error={errors.items?.[i]?.amount?.message}
                                        >
                                            <Input
                                                type="number"
                                                min={0}
                                                step="0.01"
                                                inputMode="decimal"
                                                {...register(`items.${i}.amount`)}
                                            />
                                        </FormField>
                                        <div className="col-span-2 flex justify-end sm:col-span-1 sm:pt-6">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => remove(i)}
                                                disabled={fields.length <= 1}
                                                aria-label={t('form.removeItem')}
                                            >
                                                <Trash2 aria-hidden="true" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                                <div>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        onClick={() =>
                                            append({
                                                date: isoToday(),
                                                category: 'transport',
                                                description: '',
                                                amount: undefined as never
                                            })
                                        }
                                    >
                                        <Plus aria-hidden="true" />
                                        {t('form.addItem')}
                                    </Button>
                                </div>
                            </fieldset>

                            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                                <p className="font-display text-lg font-semibold">
                                    {t('form.total', { total: money(total) })}
                                </p>
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
            ) : reports.length === 0 ? (
                <EmptyState icon={<Receipt />} title={t('empty')} description={t('emptyHint')} />
            ) : (
                <ul className="flex flex-col gap-2">
                    {reports.map((r) => (
                        <li
                            key={String(r.id)}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{reportTitle(r)}</p>
                                <p className="text-xs text-muted-foreground">
                                    {t('itemCount', { count: r.items.length })}
                                    {reportDate(r) ? ` · ${formatDate(reportDate(r), locale)}` : ''}
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="font-display text-sm font-semibold">
                                    {money(expenseReportDisplayTotal(r))}
                                </span>
                                <PortalStatusBadge status={r.status} />
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
