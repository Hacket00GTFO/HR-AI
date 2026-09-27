'use client';

import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { z } from 'zod';
import type { Vacancy } from '@/lib/schemas';
import { sendJson } from '@/lib/http';
import { formatSalary, vacancyId } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TagsInput } from '@/components/ui/tags-input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

export const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship'] as const;
export const EXPERIENCE_LEVELS = ['Entry Level', 'Mid Level', 'Senior Level', 'Executive'] as const;
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'MXN', 'CAD', 'AUD', 'JPY', 'CHF', 'BRL', 'COP', 'INR'] as const;
export const VACANCY_STATUSES = ['Active', 'Paused', 'Closed', 'Draft'] as const;

export type VacancyT = (key: string) => string;

// Locale-aware form schema — mirrors the monolith's vacancyCreateBody
// (salary is required on create; everything else maps 1:1).
export function buildVacancySchema(t: VacancyT) {
    const money = z.preprocess(
        (v) => (v === '' || v == null ? undefined : v),
        z.coerce.number(t('errors.salary')).nonnegative(t('errors.salary'))
    );
    return z
        .object({
            title: z.string().trim().min(1, t('errors.required')).max(255),
            department: z.string().trim().min(1, t('errors.required')).max(100),
            country: z.string().trim().min(1, t('errors.required')).max(100),
            city: z.string().trim().min(1, t('errors.required')).max(100),
            type: z.string().min(1, t('errors.required')).max(50),
            experience_level: z.string().min(1, t('errors.required')).max(50),
            remote_option: z.boolean(),
            description: z.string().trim().min(1, t('errors.required')),
            requirements: z.string().trim().min(1, t('errors.required')),
            responsibilities: z.string().trim().min(1, t('errors.required')),
            skills_required: z.array(z.string().trim().min(1)).min(1, t('errors.skillsRequired')),
            salary_min: money,
            salary_max: money,
            salary_currency: z.string().trim().min(1, t('errors.required')).max(10),
            benefits: z.array(z.string().trim().min(1)),
            application_deadline: z.string(),
            status: z.enum(VACANCY_STATUSES).optional()
        })
        .refine((v) => v.salary_max == null || v.salary_min == null || v.salary_max >= v.salary_min, {
            path: ['salary_max'],
            message: t('errors.salaryOrder')
        });
}
export type VacancyFormInput = z.input<ReturnType<typeof buildVacancySchema>>;
export type VacancyFormValues = z.output<ReturnType<typeof buildVacancySchema>>;

/** Map form values → the monolith's create/update body. */
export function vacancyPayload(values: VacancyFormValues, mode: 'create' | 'edit') {
    return {
        title: values.title,
        department: values.department,
        location: `${values.city} - ${values.country}`,
        type: values.type,
        description: values.description,
        requirements: values.requirements,
        responsibilities: values.responsibilities,
        skills_required: values.skills_required,
        experience_level: values.experience_level,
        salary_range: {
            min: values.salary_min,
            max: values.salary_max,
            currency: values.salary_currency
        },
        benefits: values.benefits,
        remote_option: values.remote_option,
        application_deadline: values.application_deadline || null,
        ...(mode === 'edit' && values.status ? { status: values.status } : {})
    };
}

const STEP_FIELDS: (keyof VacancyFormInput)[][] = [
    ['title', 'department', 'country', 'city', 'type', 'experience_level'],
    ['description', 'requirements', 'responsibilities', 'skills_required'],
    ['salary_min', 'salary_max', 'salary_currency', 'benefits', 'application_deadline']
];

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'edit';
    vacancy?: Vacancy | undefined;
    onSaved?: (() => void) | undefined;
}

function splitLocation(location: string | undefined | null): { city: string; country: string } {
    const parts = (location ?? '').split(' - ').map((s) => s.trim());
    if (parts.length >= 2) return { city: parts.slice(0, -1).join(' - '), country: parts[parts.length - 1] ?? '' };
    return { city: '', country: parts[0] ?? '' };
}

export function VacancyFormDialog({ open, onOpenChange, mode, vacancy, onSaved }: Props) {
    const t = useTranslations('vacancyForm');
    const tVac = useTranslations('vacancies');
    const tCommon = useTranslations('common');
    const tTypes = useTranslations('vacancyType');
    const tLevels = useTranslations('experienceLevel');
    const tStatus = useTranslations('status');
    const locale = useLocale();
    const [step, setStep] = React.useState(0);
    const [countries, setCountries] = React.useState<string[]>([]);
    const [states, setStates] = React.useState<string[] | null>(null);
    const submittingRef = React.useRef(false);
    const isCreate = mode === 'create';

    const schema = React.useMemo(() => buildVacancySchema(t), [t]);

    const defaults = React.useMemo<VacancyFormInput>(() => {
        const loc = splitLocation(vacancy?.location);
        return {
            title: vacancy?.title ?? '',
            department: vacancy?.department ?? '',
            country: loc.country,
            city: loc.city,
            type: vacancy?.type ?? '',
            experience_level: vacancy?.experience_level ?? '',
            remote_option: vacancy?.remote_option ?? false,
            description: vacancy?.description ?? '',
            requirements: vacancy?.requirements ?? '',
            responsibilities: vacancy?.responsibilities ?? '',
            skills_required: vacancy?.skills_required ?? [],
            salary_min: vacancy?.salary_range?.min ?? '',
            salary_max: vacancy?.salary_range?.max ?? '',
            salary_currency: vacancy?.salary_range?.currency ?? 'USD',
            benefits: vacancy?.benefits ?? [],
            application_deadline: vacancy?.application_deadline
                ? String(vacancy.application_deadline).slice(0, 10)
                : '',
            status: (vacancy?.status as (typeof VACANCY_STATUSES)[number]) || 'Active'
        };
    }, [vacancy]);

    const {
        register,
        control,
        handleSubmit,
        watch,
        setValue,
        trigger,
        reset,
        formState: { errors, isSubmitting }
    } = useForm<VacancyFormInput, unknown, VacancyFormValues>({
        resolver: zodResolver(schema),
        defaultValues: defaults,
        mode: 'onSubmit'
    });

    // Reset whenever the dialog (re)opens or the edited vacancy changes.
    React.useEffect(() => {
        if (open) {
            reset(defaults);
            setStep(0);
        }
    }, [open, defaults, reset]);

    const selectedCountry = watch('country');
    const selectedCity = watch('city');

    React.useEffect(() => {
        if (!open) return;
        fetch('/api/countries')
            .then((r) => (r.ok ? r.json() : []))
            .then((d) => setCountries(Array.isArray(d) ? d : []))
            .catch(() => setCountries([]));
    }, [open]);

    React.useEffect(() => {
        if (!selectedCountry) {
            setStates(null);
            return;
        }
        let cancelled = false;
        fetch(`/api/countries/${encodeURIComponent(selectedCountry)}/states`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!cancelled) setStates(Array.isArray(d) && d.length > 0 ? d : null);
            })
            .catch(() => {
                if (!cancelled) setStates(null);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedCountry]);

    const onSubmit = async (values: VacancyFormValues) => {
        if (submittingRef.current) return;
        submittingRef.current = true;
        try {
            const url = isCreate ? '/api/proxy/vacancies' : `/api/proxy/vacancies/${vacancyId(vacancy as Vacancy)}`;
            const { res } = await sendJson(url, {
                method: isCreate ? 'POST' : 'PUT',
                body: vacancyPayload(values, mode)
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(isCreate ? tVac('create.success') : tVac('edit.success'));
            onOpenChange(false);
            onSaved?.();
        } catch {
            toast.error(isCreate ? tVac('create.error') : tVac('edit.error'));
        } finally {
            submittingRef.current = false;
        }
    };

    const next = async () => {
        const valid = await trigger(STEP_FIELDS[step] as (keyof VacancyFormInput)[]);
        if (valid) setStep((s) => Math.min(s + 1, STEP_FIELDS.length));
    };

    // Country/city selects: keep the current value selectable even if it is
    // absent from the fetched lists (edit mode on legacy data).
    const countryOptions =
        selectedCountry && !countries.includes(selectedCountry) ? [selectedCountry, ...countries] : countries;
    const cityOptions =
        selectedCity && !(states ?? []).includes(selectedCity) ? [selectedCity, ...(states ?? [])] : (states ?? []);

    const values = watch();
    const stepKeys = ['basics', 'details', 'compensation', 'review'] as const;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" closeLabel={tCommon('close')}>
                <DialogHeader>
                    <DialogTitle>{isCreate ? tVac('create.title') : tVac('edit.title')}</DialogTitle>
                    <DialogDescription>
                        {isCreate
                            ? t('stepOf', { current: step + 1, total: 4 })
                            : (vacancy?.title ?? tVac('edit.title'))}
                    </DialogDescription>
                </DialogHeader>

                {isCreate && (
                    <ol aria-label={t('steps.basics')} className="flex flex-wrap gap-2" role="list">
                        {stepKeys.map((key, i) => (
                            <li
                                key={key}
                                aria-current={i === step ? 'step' : undefined}
                                className={
                                    i === step
                                        ? 'rounded-full bg-coral-500/15 px-3 py-1 text-xs font-semibold text-coral-700 dark:text-coral-300'
                                        : 'rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground'
                                }
                            >
                                {t(`steps.${key}`)}
                            </li>
                        ))}
                    </ol>
                )}

                <form
                    onSubmit={handleSubmit(onSubmit)}
                    className="flex flex-col gap-4"
                    noValidate
                    id="vacancy-form"
                    // No submit control exists before the last wizard step —
                    // block implicit Enter submission on text inputs.
                    onKeyDown={(e) => {
                        if (
                            isCreate &&
                            e.key === 'Enter' &&
                            (e.target as HTMLElement).tagName === 'INPUT' &&
                            (e.target as HTMLInputElement).type !== 'date'
                        ) {
                            e.preventDefault();
                        }
                    }}
                >
                    {/* Step 1 — basics (always rendered in edit mode) */}
                    <fieldset className={isCreate && step !== 0 ? 'hidden' : 'contents'}>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <FormField label={t('fields.title')} id="vf-title" required error={errors.title?.message}>
                                <Input {...register('title')} />
                            </FormField>
                            <FormField
                                label={t('fields.department')}
                                id="vf-dept"
                                required
                                error={errors.department?.message}
                            >
                                <Input {...register('department')} />
                            </FormField>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <FormField
                                label={t('fields.country')}
                                id="vf-country"
                                required
                                error={errors.country?.message}
                            >
                                <Select {...register('country')}>
                                    <option value="">{t('fields.selectCountry')}</option>
                                    {countryOptions.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </Select>
                            </FormField>
                            <FormField label={t('fields.city')} id="vf-city" required error={errors.city?.message}>
                                {cityOptions.length > 0 ? (
                                    <Select {...register('city')}>
                                        <option value="">{t('fields.selectCity')}</option>
                                        {cityOptions.map((s) => (
                                            <option key={s} value={s}>
                                                {s}
                                            </option>
                                        ))}
                                    </Select>
                                ) : (
                                    <Input placeholder={t('fields.selectCity')} {...register('city')} />
                                )}
                            </FormField>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <FormField label={t('fields.type')} id="vf-type" required error={errors.type?.message}>
                                <Select {...register('type')}>
                                    <option value="">{t('fields.selectType')}</option>
                                    {EMPLOYMENT_TYPES.map((ty) => (
                                        <option key={ty} value={ty}>
                                            {tTypes.has(ty) ? tTypes(ty) : ty}
                                        </option>
                                    ))}
                                </Select>
                            </FormField>
                            <FormField
                                label={t('fields.experienceLevel')}
                                id="vf-level"
                                required
                                error={errors.experience_level?.message}
                            >
                                <Select {...register('experience_level')}>
                                    <option value="">{t('fields.selectLevel')}</option>
                                    {EXPERIENCE_LEVELS.map((lv) => (
                                        <option key={lv} value={lv}>
                                            {tLevels.has(lv) ? tLevels(lv) : lv}
                                        </option>
                                    ))}
                                </Select>
                            </FormField>
                        </div>
                        <div className="flex items-center gap-2">
                            <Controller
                                control={control}
                                name="remote_option"
                                render={({ field }) => (
                                    <Switch id="vf-remote" checked={field.value} onCheckedChange={field.onChange} />
                                )}
                            />
                            <Label htmlFor="vf-remote" className="font-normal">
                                {t('fields.remote')}
                            </Label>
                        </div>
                        {!isCreate && (
                            <FormField label={t('fields.status')} id="vf-status" error={errors.status?.message}>
                                <Select {...register('status')}>
                                    {VACANCY_STATUSES.map((s) => (
                                        <option key={s} value={s}>
                                            {tStatus(s.toLowerCase() as 'active' | 'paused' | 'closed' | 'draft')}
                                        </option>
                                    ))}
                                </Select>
                            </FormField>
                        )}
                    </fieldset>

                    {/* Step 2 — role details */}
                    <fieldset className={isCreate && step !== 1 ? 'hidden' : 'contents'}>
                        <FormField
                            label={t('fields.description')}
                            id="vf-desc"
                            required
                            error={errors.description?.message}
                        >
                            <Textarea rows={4} {...register('description')} />
                        </FormField>
                        <FormField
                            label={t('fields.requirements')}
                            id="vf-req"
                            required
                            error={errors.requirements?.message}
                        >
                            <Textarea rows={4} {...register('requirements')} />
                        </FormField>
                        <FormField
                            label={t('fields.responsibilities')}
                            id="vf-resp"
                            required
                            error={errors.responsibilities?.message}
                        >
                            <Textarea rows={4} {...register('responsibilities')} />
                        </FormField>
                        <FormField
                            label={t('fields.skills')}
                            id="vf-skills"
                            required
                            error={errors.skills_required?.message}
                        >
                            <Controller
                                control={control}
                                name="skills_required"
                                render={({ field, fieldState }) => (
                                    <TagsInput
                                        id="vf-skills"
                                        value={field.value}
                                        onChange={field.onChange}
                                        placeholder={t('fields.skillsPlaceholder')}
                                        aria-invalid={fieldState.invalid || undefined}
                                        aria-describedby={fieldState.invalid ? 'vf-skills-error' : undefined}
                                    />
                                )}
                            />
                        </FormField>
                    </fieldset>

                    {/* Step 3 — compensation */}
                    <fieldset className={isCreate && step !== 2 ? 'hidden' : 'contents'}>
                        <div className="grid gap-4 sm:grid-cols-3">
                            <FormField
                                label={t('fields.salaryMin')}
                                id="vf-smin"
                                required
                                error={errors.salary_min?.message}
                            >
                                <Input type="number" min={0} inputMode="numeric" {...register('salary_min')} />
                            </FormField>
                            <FormField
                                label={t('fields.salaryMax')}
                                id="vf-smax"
                                required
                                error={errors.salary_max?.message}
                            >
                                <Input type="number" min={0} inputMode="numeric" {...register('salary_max')} />
                            </FormField>
                            <FormField
                                label={t('fields.currency')}
                                id="vf-cur"
                                required
                                error={errors.salary_currency?.message}
                            >
                                <Select {...register('salary_currency')}>
                                    {CURRENCIES.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </Select>
                            </FormField>
                        </div>
                        <FormField label={t('fields.benefits')} id="vf-benefits" error={errors.benefits?.message}>
                            <Controller
                                control={control}
                                name="benefits"
                                render={({ field }) => (
                                    <TagsInput
                                        id="vf-benefits"
                                        value={field.value}
                                        onChange={field.onChange}
                                        placeholder={t('fields.benefitsPlaceholder')}
                                    />
                                )}
                            />
                        </FormField>
                        <FormField
                            label={t('fields.deadline')}
                            id="vf-deadline"
                            error={errors.application_deadline?.message}
                        >
                            <Input type="date" {...register('application_deadline')} />
                        </FormField>
                    </fieldset>

                    {/* Step 4 — review (create only) */}
                    {isCreate && step === 3 && (
                        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4">
                            <h3 className="font-display text-base font-semibold">{t('review.title')}</h3>
                            <dl className="grid gap-2 text-sm sm:grid-cols-2">
                                <div>
                                    <dt className="text-xs text-muted-foreground">{t('fields.title')}</dt>
                                    <dd className="font-medium">{values.title}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">{t('fields.department')}</dt>
                                    <dd>{values.department}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">{t('review.location')}</dt>
                                    <dd>{`${values.city} - ${values.country}`}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">{t('fields.type')}</dt>
                                    <dd>{values.type}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">{t('review.salary')}</dt>
                                    <dd>
                                        {formatSalary(
                                            {
                                                min: Number(values.salary_min) || null,
                                                max: Number(values.salary_max) || null,
                                                currency: values.salary_currency
                                            },
                                            locale
                                        ) ?? '—'}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">{t('fields.remote')}</dt>
                                    <dd>{values.remote_option ? t('review.remoteYes') : t('review.remoteNo')}</dd>
                                </div>
                            </dl>
                            <div>
                                <p className="text-xs text-muted-foreground">{t('review.skills')}</p>
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                    {(values.skills_required ?? []).map((s) => (
                                        <Badge key={s} variant="coral">
                                            {s}
                                        </Badge>
                                    ))}
                                </div>
                            </div>
                            {values.benefits && values.benefits.length > 0 && (
                                <div>
                                    <p className="text-xs text-muted-foreground">{t('review.benefits')}</p>
                                    <div className="mt-1 flex flex-wrap gap-1.5">
                                        {values.benefits.map((b) => (
                                            <Badge key={b} variant="neutral">
                                                {b}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </form>

                <DialogFooter>
                    {isCreate ? (
                        <>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => setStep((s) => Math.max(0, s - 1))}
                                disabled={step === 0}
                            >
                                {tCommon('back')}
                            </Button>
                            {step < STEP_FIELDS.length ? (
                                <Button type="button" onClick={next}>
                                    {tCommon('next')}
                                </Button>
                            ) : (
                                <Button type="submit" form="vacancy-form" loading={isSubmitting}>
                                    {isSubmitting ? t('submitting') : t('submitCreate')}
                                </Button>
                            )}
                        </>
                    ) : (
                        <>
                            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                                {tCommon('cancel')}
                            </Button>
                            <Button type="submit" form="vacancy-form" loading={isSubmitting}>
                                {isSubmitting ? t('submitting') : t('submitEdit')}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
