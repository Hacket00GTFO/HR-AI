'use client';

import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { z } from 'zod';
import { MAX_RESUME_BYTES, vacancyListSchema, type Vacancy } from '@/lib/schemas';
import { fetchJson } from '@/lib/http';
import { vacancyId } from '@/lib/utils';
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
import { Select } from '@/components/ui/select';
import { TagsInput } from '@/components/ui/tags-input';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Preselect/lock the vacancy (vacancy detail page context). */
    vacancyId?: number | null | undefined;
    vacancyTitle?: string | undefined;
    onCreated?: (() => void) | undefined;
}

// "Register candidate" — parity with the legacy vacancies.html modal.
// Multipart POST to /api/proxy/candidates (resume file rides along).
export function CandidateCreateDialog({
    open,
    onOpenChange,
    vacancyId: lockedVacancyId,
    vacancyTitle,
    onCreated
}: Props) {
    const t = useTranslations('candidateForm');
    const tCommon = useTranslations('common');
    const [countries, setCountries] = React.useState<string[]>([]);
    const [states, setStates] = React.useState<string[] | null>(null);
    const [vacancies, setVacancies] = React.useState<Vacancy[]>([]);
    const submittingRef = React.useRef(false);

    const schema = React.useMemo(
        () =>
            z.object({
                first_name: z.string().trim().min(1, t('errors.required')).max(100),
                last_name: z.string().trim().min(1, t('errors.required')).max(100),
                email: z.email(t('errors.invalidEmail')).max(255),
                phone: z.string().trim().min(1, t('errors.required')).max(50),
                linkedin: z.string().trim().max(255),
                country: z.string().trim().min(1, t('errors.required')).max(100),
                city: z.string().trim().min(1, t('errors.required')).max(100),
                education: z.string().trim().min(1, t('errors.required')).max(255),
                current_position: z.string().trim().max(255),
                experience: z.coerce
                    .number(t('errors.experienceRange'))
                    .int(t('errors.experienceRange'))
                    .min(0, t('errors.experienceRange'))
                    .max(100, t('errors.experienceRange')),
                skills: z.array(z.string().trim().min(1)).min(1, t('errors.skillsRequired')),
                applied_for: z.string().min(1, t('errors.required')),
                resume: z
                    .custom<File>((v) => v instanceof File || v == null)
                    .nullable()
                    .refine((f) => !f || f.size <= MAX_RESUME_BYTES, { message: t('errors.resumeTooLarge') })
                    .refine((f) => !f || /\.(pdf|docx)$/i.test(f.name), { message: t('errors.resumeBadType') })
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
        setValue,
        reset,
        formState: { errors, isSubmitting }
    } = useForm<FormInput, unknown, Values>({
        resolver: zodResolver(schema),
        defaultValues: {
            first_name: '',
            last_name: '',
            email: '',
            phone: '',
            linkedin: '',
            country: '',
            city: '',
            education: '',
            current_position: '',
            experience: 0,
            skills: [],
            applied_for: lockedVacancyId != null ? String(lockedVacancyId) : '',
            resume: null
        }
    });

    const selectedCountry = watch('country');
    const resumeFile = watch('resume');

    React.useEffect(() => {
        if (!open) return;
        fetch('/api/countries')
            .then((r) => (r.ok ? r.json() : []))
            .then((d) => setCountries(Array.isArray(d) ? d : []))
            .catch(() => setCountries([]));
        if (lockedVacancyId == null) {
            fetchJson('/api/proxy/vacancies', vacancyListSchema)
                .then(setVacancies)
                .catch(() => setVacancies([]));
        } else {
            setValue('applied_for', String(lockedVacancyId));
        }
    }, [open, lockedVacancyId, setValue]);

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
        setValue('city', '');
        return () => {
            cancelled = true;
        };
    }, [selectedCountry, setValue]);

    const onSubmit = async (values: Values) => {
        if (submittingRef.current) return;
        submittingRef.current = true;
        try {
            const fd = new FormData();
            fd.set('first_name', values.first_name);
            fd.set('last_name', values.last_name);
            fd.set('email', values.email);
            fd.set('phone', values.phone);
            if (values.linkedin) fd.set('linkedin', values.linkedin);
            fd.set('experience', String(values.experience));
            fd.set('education', values.education);
            fd.set('location', `${values.city} - ${values.country}`);
            fd.set('skills', values.skills.join(', '));
            if (values.current_position) fd.set('current_position', values.current_position);
            fd.set('applied_for', values.applied_for);
            if (values.resume) fd.set('resume', values.resume, values.resume.name);

            const res = await fetch('/api/proxy/candidates', { method: 'POST', body: fd });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('success'));
            reset();
            onOpenChange(false);
            onCreated?.();
        } catch {
            toast.error(t('error'));
        } finally {
            submittingRef.current = false;
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl" closeLabel={tCommon('close')}>
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                    <DialogDescription>
                        {vacancyTitle ? `${t('fields.vacancy')}: ${vacancyTitle}` : t('title')}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                            label={t('fields.firstName')}
                            id="cc-first"
                            required
                            error={errors.first_name?.message}
                        >
                            <Input autoComplete="given-name" {...register('first_name')} />
                        </FormField>
                        <FormField label={t('fields.lastName')} id="cc-last" required error={errors.last_name?.message}>
                            <Input autoComplete="family-name" {...register('last_name')} />
                        </FormField>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label={t('fields.email')} id="cc-email" required error={errors.email?.message}>
                            <Input type="email" autoComplete="email" {...register('email')} />
                        </FormField>
                        <FormField label={t('fields.phone')} id="cc-phone" required error={errors.phone?.message}>
                            <Input type="tel" autoComplete="tel" {...register('phone')} />
                        </FormField>
                    </div>
                    <FormField label={t('fields.linkedin')} id="cc-linkedin" error={errors.linkedin?.message}>
                        <Input type="url" placeholder="https://linkedin.com/in/…" {...register('linkedin')} />
                    </FormField>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label={t('fields.country')} id="cc-country" required error={errors.country?.message}>
                            <Select {...register('country')}>
                                <option value="">{t('fields.selectCountry')}</option>
                                {countries.map((c) => (
                                    <option key={c} value={c}>
                                        {c}
                                    </option>
                                ))}
                            </Select>
                        </FormField>
                        <FormField label={t('fields.city')} id="cc-city" required error={errors.city?.message}>
                            {states ? (
                                <Select {...register('city')} disabled={!selectedCountry}>
                                    <option value="">{t('fields.selectCity')}</option>
                                    {states.map((s) => (
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
                        <FormField label={t('fields.education')} id="cc-edu" required error={errors.education?.message}>
                            <Input {...register('education')} />
                        </FormField>
                        <FormField
                            label={t('fields.currentPosition')}
                            id="cc-pos"
                            error={errors.current_position?.message}
                        >
                            <Input {...register('current_position')} />
                        </FormField>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                            label={t('fields.experience')}
                            id="cc-exp"
                            required
                            error={errors.experience?.message}
                        >
                            <Input type="number" min={0} max={100} inputMode="numeric" {...register('experience')} />
                        </FormField>
                        <FormField
                            label={t('fields.vacancy')}
                            id="cc-vacancy"
                            required
                            error={errors.applied_for?.message}
                        >
                            {lockedVacancyId != null ? (
                                <Input
                                    value={vacancyTitle ?? String(lockedVacancyId)}
                                    disabled
                                    readOnly
                                    aria-readonly="true"
                                />
                            ) : (
                                <Select {...register('applied_for')}>
                                    <option value="">{t('fields.selectVacancy')}</option>
                                    {vacancies.map((v) => (
                                        <option key={vacancyId(v)} value={vacancyId(v)}>
                                            {v.title}
                                        </option>
                                    ))}
                                </Select>
                            )}
                        </FormField>
                    </div>
                    <FormField label={t('fields.skills')} id="cc-skills" required error={errors.skills?.message}>
                        <Controller
                            control={control}
                            name="skills"
                            render={({ field, fieldState }) => (
                                <TagsInput
                                    id="cc-skills"
                                    value={field.value}
                                    onChange={field.onChange}
                                    placeholder={t('fields.skillsPlaceholder')}
                                    aria-invalid={fieldState.invalid || undefined}
                                    aria-describedby={fieldState.invalid ? 'cc-skills-error' : undefined}
                                />
                            )}
                        />
                    </FormField>
                    <FormField
                        label={t('fields.resume')}
                        id="cc-resume"
                        hint={t('fields.resumeHelp')}
                        error={errors.resume?.message as string | undefined}
                    >
                        <Controller
                            control={control}
                            name="resume"
                            render={({ field }) => (
                                <Input
                                    id="cc-resume"
                                    type="file"
                                    accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                    onChange={(e) => field.onChange(e.target.files?.[0] ?? null)}
                                    onBlur={field.onBlur}
                                    name={field.name}
                                    ref={field.ref}
                                />
                            )}
                        />
                    </FormField>
                    {resumeFile && (
                        <p className="text-xs text-muted-foreground" role="status">
                            {resumeFile.name}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                            {tCommon('cancel')}
                        </Button>
                        <Button type="submit" loading={isSubmitting}>
                            {isSubmitting ? t('submitting') : t('submit')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
