'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, FileText, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { TagsInput } from '@/components/ui/tags-input';
import { Textarea } from '@/components/ui/textarea';
import { MAX_RESUME_BYTES } from '@/lib/schemas';
import { cn } from '@/lib/utils';

interface Props {
    vacancyId: number;
    vacancyTitle: string;
}

// Candidate-portal application form → POST /api/apply (multipart, forwards to
// POST /v1/public/apply). On 201 the backend returns { application_id } which
// is shown to the candidate as their tracking folio.
//
// NOTE: `cover_letter` is sent but currently ignored upstream — the
// recruitment-core publicApplyBody schema (.strip()) has no cover_letter
// field. Tracked for the backend to persist; the UI already collects it.
export function CandidateApplyForm({ vacancyId, vacancyTitle }: Props) {
    const t = useTranslations('portal.candidate.apply');
    const [phase, setPhase] = React.useState<'form' | 'success' | 'duplicate'>('form');
    const [folio, setFolio] = React.useState<string | null>(null);
    const [dragging, setDragging] = React.useState(false);
    const submittingRef = React.useRef(false);

    const schema = React.useMemo(
        () =>
            z.object({
                first_name: z.string().trim().min(1, t('errors.required')).max(100),
                last_name: z.string().trim().min(1, t('errors.required')).max(100),
                email: z.email(t('errors.invalidEmail')).max(255),
                phone: z.string().trim().min(1, t('errors.required')).max(50),
                location: z.string().trim().min(1, t('errors.required')).max(255),
                experience: z.coerce
                    .number(t('errors.experienceRange'))
                    .int(t('errors.experienceRange'))
                    .min(0, t('errors.experienceRange'))
                    .max(100, t('errors.experienceRange')),
                education: z.string().trim().min(1, t('errors.required')).max(255),
                skills: z.array(z.string().trim().min(1)).min(1, t('errors.skillsRequired')),
                cover_letter: z.string().trim().max(5000),
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

    const {
        register,
        control,
        handleSubmit,
        watch,
        formState: { errors, isSubmitting }
    } = useForm<FormInput, unknown, Values>({
        resolver: zodResolver(schema),
        defaultValues: {
            first_name: '',
            last_name: '',
            email: '',
            phone: '',
            location: '',
            experience: 0,
            education: '',
            skills: [],
            cover_letter: '',
            resume: null
        }
    });

    const resumeFile = watch('resume');

    const onSubmit = async (values: Values) => {
        if (submittingRef.current) return;
        submittingRef.current = true;
        try {
            const fd = new FormData();
            fd.set('first_name', values.first_name);
            fd.set('last_name', values.last_name);
            fd.set('email', values.email);
            fd.set('phone', values.phone);
            fd.set('experience', String(values.experience));
            fd.set('education', values.education);
            fd.set('location', values.location);
            fd.set('skills', values.skills.join(', '));
            if (values.cover_letter) fd.set('cover_letter', values.cover_letter);
            fd.set('applied_for', String(vacancyId));
            if (values.resume) fd.set('resume', values.resume, values.resume.name);

            const res = await fetch('/api/apply', { method: 'POST', body: fd });
            if (res.status === 201) {
                const data = (await res.json().catch(() => null)) as { application_id?: number } | null;
                setFolio(data?.application_id != null ? `APP-${String(data.application_id).padStart(6, '0')}` : null);
                setPhase('success');
                return;
            }
            if (res.status === 200) {
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
                    {success && folio && (
                        <p className="rounded-lg bg-muted px-4 py-2 font-display text-lg font-semibold tracking-wide">
                            {t('success.folio', { folio })}
                        </p>
                    )}
                    <p className="max-w-sm text-sm text-muted-foreground">
                        {success ? t('success.body') : t('duplicate.body')}
                    </p>
                    <Button asChild variant="secondary">
                        <Link href="/portal/candidato">{t('success.backToJobs')}</Link>
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
                            id="ca-first-name"
                            required
                            error={errors.first_name?.message}
                        >
                            <Input autoComplete="given-name" {...register('first_name')} />
                        </FormField>
                        <FormField
                            label={t('fields.lastName')}
                            id="ca-last-name"
                            required
                            error={errors.last_name?.message}
                        >
                            <Input autoComplete="family-name" {...register('last_name')} />
                        </FormField>
                    </div>
                    <FormField label={t('fields.email')} id="ca-email" required error={errors.email?.message}>
                        <Input type="email" autoComplete="email" {...register('email')} />
                    </FormField>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label={t('fields.phone')} id="ca-phone" required error={errors.phone?.message}>
                            <Input type="tel" autoComplete="tel" {...register('phone')} />
                        </FormField>
                        <FormField
                            label={t('fields.location')}
                            id="ca-location"
                            required
                            error={errors.location?.message}
                        >
                            <Input placeholder={t('fields.locationPlaceholder')} {...register('location')} />
                        </FormField>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                            label={t('fields.experience')}
                            id="ca-experience"
                            required
                            error={errors.experience?.message}
                        >
                            <Input type="number" min={0} max={100} inputMode="numeric" {...register('experience')} />
                        </FormField>
                        <FormField
                            label={t('fields.education')}
                            id="ca-education"
                            required
                            error={errors.education?.message}
                        >
                            <Input placeholder={t('fields.educationPlaceholder')} {...register('education')} />
                        </FormField>
                    </div>
                    <FormField label={t('fields.skills')} id="ca-skills" required error={errors.skills?.message}>
                        <Controller
                            control={control}
                            name="skills"
                            render={({ field, fieldState }) => (
                                <TagsInput
                                    id="ca-skills"
                                    value={field.value}
                                    onChange={field.onChange}
                                    placeholder={t('fields.skillsPlaceholder')}
                                    aria-invalid={fieldState.invalid || undefined}
                                    aria-describedby={fieldState.invalid ? 'ca-skills-error' : undefined}
                                />
                            )}
                        />
                    </FormField>
                    <FormField
                        label={t('fields.coverLetter')}
                        id="ca-cover-letter"
                        hint={t('fields.coverLetterHint')}
                        error={errors.cover_letter?.message}
                    >
                        <Textarea rows={4} maxLength={5000} {...register('cover_letter')} />
                    </FormField>
                    <FormField
                        label={t('fields.resume')}
                        id="ca-resume"
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
                                    aria-describedby={`ca-resume-hint${fieldState.invalid ? ' ca-resume-error' : ''}`}
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
                                        id="ca-resume"
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
                    <Button type="submit" loading={isSubmitting}>
                        {t('submit')}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
