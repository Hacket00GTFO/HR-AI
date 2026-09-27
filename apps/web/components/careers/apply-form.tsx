'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { z } from 'zod';
import { CheckCircle2, FileText, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormField } from '@/components/ui/form-field';
import { TagsInput } from '@/components/ui/tags-input';
import { MAX_RESUME_BYTES } from '@/lib/schemas';
import { cn } from '@/lib/utils';

interface Props {
    vacancyId: number;
    vacancyTitle: string;
}

const DRAFT_KEY = (id: number) => `strafor-apply-draft-${id}`;

export function ApplyForm({ vacancyId, vacancyTitle }: Props) {
    const t = useTranslations('apply');
    const router = useRouter();
    const [phase, setPhase] = React.useState<'form' | 'success' | 'duplicate'>('form');
    const [countries, setCountries] = React.useState<string[]>([]);
    const [states, setStates] = React.useState<string[] | null>(null);
    const [countriesError, setCountriesError] = React.useState(false);
    const [dragging, setDragging] = React.useState(false);
    const submittingRef = React.useRef(false);

    // Schema is built per-locale so validation messages are translated.
    const schema = React.useMemo(
        () =>
            z.object({
                first_name: z.string().trim().min(1, t('errors.required')).max(100),
                last_name: z.string().trim().min(1, t('errors.required')).max(100),
                email: z.email(t('errors.invalidEmail')).max(255),
                phone: z.string().trim().min(1, t('errors.required')).max(50),
                linkedin: z.string().trim().max(255),
                experience: z.coerce
                    .number(t('errors.experienceRange'))
                    .int(t('errors.experienceRange'))
                    .min(0, t('errors.experienceRange'))
                    .max(100, t('errors.experienceRange')),
                education: z.string().trim().min(1, t('errors.required')).max(255),
                country: z.string().trim().min(1, t('errors.required')).max(100),
                state: z.string().trim().max(100),
                skills: z.array(z.string().trim().min(1)).min(1, t('errors.skillsRequired')),
                current_position: z.string().trim().max(255),
                resume: z
                    .custom<File>((v) => v instanceof File || v == null)
                    .nullable()
                    .refine((f) => !f || f.size <= MAX_RESUME_BYTES, { message: t('errors.resumeTooLarge') })
                    .refine(
                        (f) =>
                            !f ||
                            [
                                'application/pdf',
                                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                            ].includes(f.type) ||
                            /\.(pdf|docx)$/i.test(f.name),
                        { message: t('errors.resumeBadType') }
                    )
            }),
        [t]
    );
    type FormInput = z.input<typeof schema>;
    type Values = z.output<typeof schema>;

    const emptyValues: FormInput = {
        first_name: '',
        last_name: '',
        email: '',
        phone: '',
        linkedin: '',
        experience: 0,
        education: '',
        country: '',
        state: '',
        skills: [],
        current_position: '',
        resume: null
    };

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
        defaultValues: emptyValues
    });

    const selectedCountry = watch('country');
    const resumeFile = watch('resume');

    // ---------- draft persistence (sessionStorage; file is not persisted) ----------
    React.useEffect(() => {
        try {
            const raw = sessionStorage.getItem(DRAFT_KEY(vacancyId));
            if (raw) {
                const draft = JSON.parse(raw) as Partial<Values>;
                reset({ ...draft, resume: null } as Values);
                toast.info(t('draftRestored'));
            }
        } catch {
            /* corrupted draft — ignore */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vacancyId]);

    React.useEffect(() => {
        const sub = watch((values) => {
            try {
                const persistable = { ...values };
                delete persistable.resume;
                sessionStorage.setItem(DRAFT_KEY(vacancyId), JSON.stringify(persistable));
            } catch {
                /* storage full/blocked — ignore */
            }
        });
        return () => sub.unsubscribe();
    }, [watch, vacancyId]);

    // ---------- countries + cascading states ----------
    React.useEffect(() => {
        fetch('/api/countries')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((d) => setCountries(Array.isArray(d) ? d : []))
            .catch(() => setCountriesError(true));
    }, []);

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
        setValue('state', '');
        return () => {
            cancelled = true;
        };
    }, [selectedCountry, setValue]);

    // ---------- submit ----------
    const onSubmit = async (values: Values) => {
        if (submittingRef.current) return; // double-submit guard
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
            fd.set('location', [values.state, values.country].filter(Boolean).join(', '));
            fd.set('skills', values.skills.join(', '));
            if (values.current_position) fd.set('current_position', values.current_position);
            fd.set('applied_for', String(vacancyId));
            if (values.resume) fd.set('resume', values.resume, values.resume.name);

            const res = await fetch('/api/apply', { method: 'POST', body: fd });
            if (res.status === 201) {
                sessionStorage.removeItem(DRAFT_KEY(vacancyId));
                setPhase('success');
                return;
            }
            if (res.status === 200) {
                sessionStorage.removeItem(DRAFT_KEY(vacancyId));
                setPhase('duplicate');
                return;
            }
            if (res.status === 429) toast.error(t('errors.rateLimited'));
            else if (res.status === 404) toast.error(t('errors.vacancyGone'));
            else if (res.status === 413) toast.error(t('errors.resumeTooLarge'));
            else if (res.status === 415) toast.error(t('errors.resumeBadType'));
            else toast.error(t('errors.generic'));
        } catch {
            toast.error(t('errors.generic'));
        } finally {
            submittingRef.current = false;
        }
    };

    if (phase === 'success' || phase === 'duplicate') {
        const success = phase === 'success';
        return (
            <Card>
                <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
                    <CheckCircle2
                        aria-hidden="true"
                        className={cn('size-12', success ? 'text-success-500' : 'text-info-500')}
                    />
                    <h2 className="font-display text-xl font-semibold">
                        {success ? t('success.title') : t('duplicate.title')}
                    </h2>
                    <p className="max-w-sm text-sm text-muted-foreground">
                        {success ? t('success.body') : t('duplicate.body')}
                    </p>
                    {success && (
                        <div className="w-full rounded-lg bg-muted p-4 text-left">
                            <p className="text-sm font-semibold">{t('success.whatNext')}</p>
                            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                                <li>{t('success.step1')}</li>
                                <li>{t('success.step2')}</li>
                                <li>{t('success.step3')}</li>
                            </ol>
                        </div>
                    )}
                    <Button variant="secondary" onClick={() => router.push('/careers')}>
                        {t('success.backToCareers')}
                    </Button>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('title')}</CardTitle>
                <p className="text-sm text-muted-foreground">{t('subtitle', { title: vacancyTitle })}</p>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                            label={t('fields.firstName')}
                            id="af-first-name"
                            required
                            error={errors.first_name?.message}
                        >
                            <Input autoComplete="given-name" {...register('first_name')} />
                        </FormField>
                        <FormField
                            label={t('fields.lastName')}
                            id="af-last-name"
                            required
                            error={errors.last_name?.message}
                        >
                            <Input autoComplete="family-name" {...register('last_name')} />
                        </FormField>
                    </div>
                    <FormField label={t('fields.email')} id="af-email" required error={errors.email?.message}>
                        <Input type="email" autoComplete="email" {...register('email')} />
                    </FormField>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label={t('fields.phone')} id="af-phone" required error={errors.phone?.message}>
                            <Input type="tel" autoComplete="tel" {...register('phone')} />
                        </FormField>
                        <FormField label={t('fields.linkedin')} id="af-linkedin" error={errors.linkedin?.message}>
                            <Input type="url" placeholder={t('fields.linkedinPlaceholder')} {...register('linkedin')} />
                        </FormField>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                            label={t('fields.experience')}
                            id="af-experience"
                            required
                            error={errors.experience?.message}
                        >
                            <Input type="number" min={0} max={100} inputMode="numeric" {...register('experience')} />
                        </FormField>
                        <FormField
                            label={t('fields.education')}
                            id="af-education"
                            required
                            error={errors.education?.message}
                        >
                            <Input placeholder={t('fields.educationPlaceholder')} {...register('education')} />
                        </FormField>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label={t('fields.country')} id="af-country" required error={errors.country?.message}>
                            {countries.length > 0 ? (
                                <Select {...register('country')}>
                                    <option value="">{t('fields.selectCountry')}</option>
                                    {countries.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </Select>
                            ) : (
                                <Input
                                    placeholder={t('fields.selectCountry')}
                                    aria-describedby={countriesError ? 'af-country-fallback' : undefined}
                                    {...register('country')}
                                />
                            )}
                        </FormField>
                        <FormField label={t('fields.state')} id="af-state" error={errors.state?.message}>
                            {states ? (
                                <Select {...register('state')} disabled={!selectedCountry}>
                                    <option value="">{t('fields.selectState')}</option>
                                    {states.map((s) => (
                                        <option key={s} value={s}>
                                            {s}
                                        </option>
                                    ))}
                                </Select>
                            ) : (
                                <Input placeholder={t('fields.selectState')} {...register('state')} />
                            )}
                        </FormField>
                    </div>
                    <FormField label={t('fields.skills')} id="af-skills" required error={errors.skills?.message}>
                        <Controller
                            control={control}
                            name="skills"
                            render={({ field, fieldState }) => (
                                <TagsInput
                                    id="af-skills"
                                    value={field.value}
                                    onChange={field.onChange}
                                    placeholder={t('fields.skillsPlaceholder')}
                                    aria-invalid={fieldState.invalid || undefined}
                                    aria-describedby={fieldState.invalid ? 'af-skills-error' : undefined}
                                />
                            )}
                        />
                    </FormField>
                    <FormField
                        label={t('fields.currentPosition')}
                        id="af-current-position"
                        error={errors.current_position?.message}
                    >
                        <Input placeholder={t('fields.currentPositionPlaceholder')} {...register('current_position')} />
                    </FormField>
                    <FormField
                        label={t('fields.resume')}
                        id="af-resume"
                        hint={t('fields.resumeHelp')}
                        error={errors.resume?.message as string | undefined}
                    >
                        <Controller
                            control={control}
                            name="resume"
                            render={({ field, fieldState }) => (
                                <div
                                    role="button"
                                    tabIndex={0}
                                    aria-describedby={`af-resume-hint${fieldState.invalid ? ' af-resume-error' : ''}`}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            e.currentTarget.querySelector('input')?.click();
                                        }
                                    }}
                                    onClick={(e) => e.currentTarget.querySelector('input')?.click()}
                                    onDragOver={(e) => {
                                        e.preventDefault();
                                        setDragging(true);
                                    }}
                                    onDragLeave={() => setDragging(false)}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        setDragging(false);
                                        const file = e.dataTransfer.files?.[0];
                                        if (file) field.onChange(file);
                                    }}
                                    className={cn(
                                        'flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-coral-500 hover:text-foreground',
                                        dragging && 'border-coral-500 bg-coral-500/5',
                                        fieldState.invalid && 'border-danger-500'
                                    )}
                                >
                                    <input
                                        id="af-resume"
                                        type="file"
                                        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                        className="sr-only"
                                        tabIndex={-1}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => field.onChange(e.target.files?.[0] ?? null)}
                                        onBlur={field.onBlur}
                                        name={field.name}
                                        ref={field.ref}
                                    />
                                    {resumeFile ? (
                                        <>
                                            <FileText className="size-6 text-coral-600" aria-hidden="true" />
                                            <span className="font-medium text-foreground">
                                                {t('fields.resumeSelected', { name: resumeFile.name })}
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <UploadCloud className="size-6" aria-hidden="true" />
                                            <span>{t('fields.resumeChoose')}</span>
                                        </>
                                    )}
                                </div>
                            )}
                        />
                    </FormField>
                    <Button type="submit" size="lg" loading={isSubmitting} className="mt-2 w-full">
                        {isSubmitting ? t('submitting') : t('submit')}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
