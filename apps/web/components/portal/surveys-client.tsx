'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { BarChart3, ClipboardList, Lock, Plus, SearchX, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { fetchJson, sendJson, errorMessage } from '@/lib/http';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PortalStatusBadge } from './portal-status-badge';
import {
    cellThreshold,
    formatAvgScore,
    groupLabel,
    isSuppressedResult,
    normalizeSurveys,
    pivotResults,
    surveyListResponseSchema,
    surveyResultsResponseSchema,
    type Survey,
    type SurveyResults
} from './surveys-lib';

type LoadState = 'loading' | 'error' | 'done';
const SURVEY_TYPES = ['nom035', 'climate'] as const;

// Encuestas — HR survey console: list/create drafts, open/close lifecycle,
// k-anonymised aggregate results.
// Upstream (hr-services /v1/surveys, HR-only): see surveys-lib.tsx header.
// STRICT create body — only allowlisted keys are sent. Results cells under
// the anonymity threshold render a lock state (never blank numbers).
export function SurveysClient() {
    const t = useTranslations('portal.surveys');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [surveys, setSurveys] = React.useState<Survey[]>([]);
    const [state, setState] = React.useState<LoadState>('loading');
    const [formOpen, setFormOpen] = React.useState(false);
    const [acting, setActing] = React.useState<string | null>(null);

    const [resultsFor, setResultsFor] = React.useState<Survey | null>(null);
    const [results, setResults] = React.useState<SurveyResults | null>(null);
    const [resultsState, setResultsState] = React.useState<LoadState>('loading');

    const schema = React.useMemo(
        () =>
            z.object({
                title: z.string().trim().min(1, t('errors.titleRequired')).max(300),
                type: z.enum(SURVEY_TYPES, { message: t('errors.typeRequired') }),
                opensAt: z.string().optional().default(''),
                closesAt: z.string().optional().default(''),
                questions: z
                    .array(
                        z.object({
                            dimension: z.string().trim().min(1, t('errors.dimensionRequired')).max(100),
                            text: z.string().trim().min(1, t('errors.textRequired')).max(2000),
                            scale: z.coerce
                                .number()
                                .int(t('errors.scaleRange'))
                                .min(2, t('errors.scaleRange'))
                                .max(10, t('errors.scaleRange')),
                            healthRelated: z.boolean().optional().default(false)
                        })
                    )
                    .min(1, t('errors.questionRequired'))
                    .max(200)
            }),
        [t]
    );
    type FormInput = z.input<typeof schema>;
    type Values = z.output<typeof schema>;

    const {
        register,
        control,
        handleSubmit,
        reset,
        formState: { errors, isSubmitting }
    } = useForm<FormInput, unknown, Values>({
        resolver: zodResolver(schema),
        defaultValues: {
            title: '',
            type: 'climate',
            opensAt: '',
            closesAt: '',
            questions: [{ dimension: '', text: '', scale: 5, healthRelated: false }]
        }
    });
    const { fields, append, remove } = useFieldArray({ control, name: 'questions' });

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const data = await fetchJson('/api/proxy/surveys', surveyListResponseSchema);
            setSurveys(normalizeSurveys(data));
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const toIso = (v: string | undefined) => (v ? new Date(v).toISOString() : null);

    const onSubmit = async (values: Values) => {
        const { res, data } = await sendJson('/api/proxy/surveys', {
            method: 'POST',
            body: {
                title: values.title,
                type: values.type,
                opensAt: toIso(values.opensAt),
                closesAt: toIso(values.closesAt),
                questions: values.questions.map((q) => ({
                    dimension: q.dimension,
                    text: q.text,
                    scale: q.scale,
                    healthRelated: q.healthRelated
                }))
            }
        });
        if (res.ok) {
            toast.success(t('createOk'));
            reset({
                title: '',
                type: 'climate',
                opensAt: '',
                closesAt: '',
                questions: [{ dimension: '', text: '', scale: 5, healthRelated: false }]
            });
            setFormOpen(false);
            load();
            return;
        }
        toast.error(errorMessage(data) ?? t('errors.generic'));
    };

    const lifecycle = async (s: Survey, action: 'open' | 'close') => {
        const key = `${String(s.id)}:${action}`;
        setActing(key);
        try {
            const { res, data } = await sendJson(`/api/proxy/surveys/${s.id}/${action}`, { method: 'POST', body: {} });
            if (res.ok) {
                toast.success(action === 'open' ? t('openOk') : t('closeOk'));
                load();
                return;
            }
            if (res.status === 409) toast.error(errorMessage(data) ?? t('errors.badState'));
            else toast.error(errorMessage(data) ?? t('errors.generic'));
        } catch {
            toast.error(t('errors.generic'));
        } finally {
            setActing(null);
        }
    };

    const openResults = React.useCallback(async (s: Survey) => {
        setResultsFor(s);
        setResults(null);
        setResultsState('loading');
        try {
            const data = await fetchJson(`/api/proxy/surveys/${s.id}/results`, surveyResultsResponseSchema);
            setResults(data);
            setResultsState('done');
        } catch {
            setResultsState('error');
        }
    }, []);

    const pivot = React.useMemo(() => (results ? pivotResults(results.results) : null), [results]);

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
                            <div className="grid gap-4 sm:grid-cols-2">
                                <FormField
                                    label={t('form.titleField')}
                                    id="sv-title"
                                    required
                                    error={errors.title?.message}
                                >
                                    <Input maxLength={300} {...register('title')} />
                                </FormField>
                                <FormField label={t('form.type')} id="sv-type" required error={errors.type?.message}>
                                    <Select {...register('type')}>
                                        {SURVEY_TYPES.map((ty) => (
                                            <option key={ty} value={ty}>
                                                {t(`types.${ty}`)}
                                            </option>
                                        ))}
                                    </Select>
                                </FormField>
                            </div>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <FormField label={t('form.opensAt')} id="sv-opens" hint={t('form.scheduleHint')}>
                                    <Input type="datetime-local" {...register('opensAt')} />
                                </FormField>
                                <FormField label={t('form.closesAt')} id="sv-closes">
                                    <Input type="datetime-local" {...register('closesAt')} />
                                </FormField>
                            </div>

                            <fieldset className="flex flex-col gap-3">
                                <legend className="text-sm font-medium">{t('form.questions')}</legend>
                                {errors.questions?.root?.message && (
                                    <p role="alert" className="text-xs font-medium text-danger-500">
                                        {errors.questions.root.message}
                                    </p>
                                )}
                                {fields.map((field, i) => (
                                    <div
                                        key={field.id}
                                        className="grid grid-cols-2 items-start gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_2fr_6rem_7rem_auto]"
                                    >
                                        <FormField
                                            label={t('form.dimension')}
                                            id={`sv-q-${i}-dim`}
                                            required
                                            error={errors.questions?.[i]?.dimension?.message}
                                        >
                                            <Input maxLength={100} {...register(`questions.${i}.dimension`)} />
                                        </FormField>
                                        <FormField
                                            label={t('form.questionText')}
                                            id={`sv-q-${i}-text`}
                                            required
                                            error={errors.questions?.[i]?.text?.message}
                                        >
                                            <Input maxLength={2000} {...register(`questions.${i}.text`)} />
                                        </FormField>
                                        <FormField
                                            label={t('form.scale')}
                                            id={`sv-q-${i}-scale`}
                                            error={errors.questions?.[i]?.scale?.message}
                                        >
                                            <Input
                                                type="number"
                                                min={2}
                                                max={10}
                                                inputMode="numeric"
                                                {...register(`questions.${i}.scale`)}
                                            />
                                        </FormField>
                                        <div className="flex flex-col gap-1.5 pt-6">
                                            <label
                                                htmlFor={`sv-q-${i}-health`}
                                                className="flex items-center gap-2 text-xs text-muted-foreground"
                                            >
                                                <input
                                                    id={`sv-q-${i}-health`}
                                                    type="checkbox"
                                                    className="size-4 accent-coral-600"
                                                    {...register(`questions.${i}.healthRelated`)}
                                                />
                                                {t('form.healthRelated')}
                                            </label>
                                        </div>
                                        <div className="col-span-2 flex justify-end sm:col-span-1 sm:pt-6">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => remove(i)}
                                                disabled={fields.length <= 1}
                                                aria-label={t('form.removeQuestion')}
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
                                            append({ dimension: '', text: '', scale: 5, healthRelated: false })
                                        }
                                    >
                                        <Plus aria-hidden="true" />
                                        {t('form.addQuestion')}
                                    </Button>
                                </div>
                            </fieldset>

                            <div className="flex justify-end border-t border-border pt-4">
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
                        <Skeleton key={i} className="h-20 rounded-lg" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : surveys.length === 0 ? (
                <EmptyState icon={<ClipboardList />} title={t('empty')} description={t('emptyHint')} />
            ) : (
                <ul className="flex flex-col gap-2">
                    {surveys.map((s) => (
                        <li
                            key={String(s.id)}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                        >
                            <div className="min-w-0">
                                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                    <span className="truncate">{s.title || `#${String(s.id)}`}</span>
                                    <Badge variant="neutral">
                                        {(SURVEY_TYPES as readonly string[]).includes(s.type)
                                            ? t(`types.${s.type as (typeof SURVEY_TYPES)[number]}`)
                                            : s.type}
                                    </Badge>
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t('responses', { count: s.responseCount ?? 0 })}
                                    {s.closesAt ? ` · ${t('closesAt', { date: formatDate(s.closesAt, locale) })}` : ''}
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <PortalStatusBadge status={s.status} />
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => openResults(s)}
                                    aria-label={t('resultsFor', { name: s.title || String(s.id) })}
                                >
                                    <BarChart3 aria-hidden="true" />
                                    {t('viewResults')}
                                </Button>
                                {s.status === 'draft' && (
                                    <Button
                                        size="sm"
                                        loading={acting === `${String(s.id)}:open`}
                                        disabled={acting !== null}
                                        onClick={() => lifecycle(s, 'open')}
                                    >
                                        {t('open')}
                                    </Button>
                                )}
                                {s.status === 'open' && (
                                    <Button
                                        size="sm"
                                        variant="danger"
                                        loading={acting === `${String(s.id)}:close`}
                                        disabled={acting !== null}
                                        onClick={() => lifecycle(s, 'close')}
                                    >
                                        {t('close')}
                                    </Button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <Dialog open={resultsFor !== null} onOpenChange={(open) => !open && setResultsFor(null)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" closeLabel={tCommon('close')}>
                    <DialogHeader>
                        <DialogTitle>{t('resultsTitle', { name: resultsFor?.title || '' })}</DialogTitle>
                    </DialogHeader>

                    {resultsState === 'loading' ? (
                        <div aria-busy="true" className="flex flex-col gap-2">
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-10 rounded-lg" />
                            ))}
                        </div>
                    ) : resultsState === 'error' || !results || !pivot ? (
                        <EmptyState
                            icon={<SearchX />}
                            title={t('resultsError')}
                            actionLabel={tCommon('retry')}
                            onAction={() => resultsFor && openResults(resultsFor)}
                        />
                    ) : (
                        <div className="flex flex-col gap-4">
                            <p className="text-xs text-muted-foreground" role="status">
                                {t('resultsSummary', {
                                    respondents: results.respondents,
                                    min: results.minGroupSize
                                })}
                            </p>
                            {results.results.length === 0 ? (
                                <EmptyState icon={<BarChart3 />} title={t('resultsEmpty')} />
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('dimension')}</TableHead>
                                            {pivot.groups.map((g) => (
                                                <TableHead key={g} className="text-right">
                                                    {groupLabel(g, t('allGroup'))}
                                                </TableHead>
                                            ))}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {pivot.rows.map((row) => (
                                            <TableRow key={row.dimension || '(blank)'}>
                                                <TableCell className="font-medium">
                                                    {row.dimension || t('noDimension')}
                                                </TableCell>
                                                {row.cells.map((cell, i) => (
                                                    <TableCell key={pivot.groups[i]} className="text-right">
                                                        {cell === null ? (
                                                            <span className="text-muted-foreground">—</span>
                                                        ) : isSuppressedResult(cell) ? (
                                                            <span
                                                                className="inline-flex items-center gap-1 text-muted-foreground"
                                                                title={t('suppressedHint', {
                                                                    min: cellThreshold(cell, results.minGroupSize)
                                                                })}
                                                            >
                                                                <Lock className="size-3.5" aria-hidden="true" />
                                                                <span className="sr-only">
                                                                    {t('suppressedHint', {
                                                                        min: cellThreshold(cell, results.minGroupSize)
                                                                    })}
                                                                </span>
                                                                k&lt;{cellThreshold(cell, results.minGroupSize)}
                                                            </span>
                                                        ) : (
                                                            <span className="tabular-nums">
                                                                {formatAvgScore(cell.avgScore)}
                                                                <span className="block text-[10px] text-muted-foreground">
                                                                    {t('respondentsCount', {
                                                                        count: cell.respondents ?? 0
                                                                    })}
                                                                </span>
                                                            </span>
                                                        )}
                                                    </TableCell>
                                                ))}
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Lock className="size-3.5 shrink-0" aria-hidden="true" />
                                {t('anonymityNote', { min: results.minGroupSize })}
                            </p>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
