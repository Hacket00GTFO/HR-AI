'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';

const formSchema = z.object({
    email: z.string().min(1).email(),
    password: z.string().min(1)
});
type FormValues = z.infer<typeof formSchema>;

const mfaSchema = z.object({
    code: z.string().min(1)
});
type MfaValues = z.infer<typeof mfaSchema>;

export function LoginForm() {
    const t = useTranslations('login');
    const tm = useTranslations('mfa');
    const router = useRouter();
    const params = useSearchParams();
    const [serverError, setServerError] = React.useState<string | null>(null);
    // When the backend answers login with mfa_required we keep the challenge
    // token here and swap the form to the code-entry step.
    const [challengeToken, setChallengeToken] = React.useState<string | null>(null);
    const [useRecoveryCode, setUseRecoveryCode] = React.useState(false);

    const nextPath = () => {
        const next = params.get('next');
        return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
    };

    const {
        register,
        handleSubmit,
        formState: { errors, isSubmitting }
    } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

    const {
        register: registerMfa,
        handleSubmit: handleSubmitMfa,
        formState: { errors: mfaErrors, isSubmitting: mfaSubmitting }
    } = useForm<MfaValues>({ resolver: zodResolver(mfaSchema) });

    const onSubmit = async (values: FormValues) => {
        setServerError(null);
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setServerError(res.status === 401 ? t('errors.invalidCredentials') : t('errors.generic'));
                return;
            }
            // MFA gate — enrolled users must complete the code step.
            if (data.mfa_required && data.challenge_token) {
                setChallengeToken(data.challenge_token);
                return;
            }
            // Password-only login with MFA still pending → force enrollment.
            if (data.mfaSetupRequired) {
                router.push('/mfa/setup');
                router.refresh();
                return;
            }
            router.push(nextPath());
            router.refresh();
        } catch {
            setServerError(t('errors.generic'));
        }
    };

    const onMfaSubmit = async (values: MfaValues) => {
        setServerError(null);
        try {
            const res = await fetch('/api/auth/mfa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    useRecoveryCode
                        ? { challenge_token: challengeToken, recovery_code: values.code }
                        : { challenge_token: challengeToken, totp_code: values.code }
                )
            });
            if (!res.ok) {
                setServerError(res.status === 401 ? tm('errors.invalidCode') : t('errors.generic'));
                return;
            }
            router.push(nextPath());
            router.refresh();
        } catch {
            setServerError(t('errors.generic'));
        }
    };

    // ---- Step 2: MFA challenge ----
    if (challengeToken) {
        return (
            <form onSubmit={handleSubmitMfa(onMfaSubmit)} className="mt-8 flex flex-col gap-5" noValidate>
                <p className="text-sm text-muted-foreground">
                    {useRecoveryCode ? tm('recoveryPrompt') : tm('challengePrompt')}
                </p>
                <FormField
                    label={useRecoveryCode ? tm('recoveryCodeLabel') : tm('codeLabel')}
                    id="mfa-code"
                    required
                    error={mfaErrors.code ? tm('errors.codeRequired') : undefined}
                >
                    <Input
                        type="text"
                        inputMode={useRecoveryCode ? 'text' : 'numeric'}
                        autoComplete={useRecoveryCode ? 'off' : 'one-time-code'}
                        placeholder={useRecoveryCode ? tm('recoveryCodePlaceholder') : tm('codePlaceholder')}
                        {...registerMfa('code')}
                    />
                </FormField>

                {serverError && (
                    <p
                        role="alert"
                        className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-500 dark:text-red-300"
                    >
                        {serverError}
                    </p>
                )}

                <Button type="submit" size="lg" loading={mfaSubmitting} className="w-full">
                    {mfaSubmitting ? tm('verifying') : tm('verify')}
                </Button>
                <div className="flex items-center justify-between text-sm">
                    <button
                        type="button"
                        className="text-coral-600 hover:underline dark:text-coral-500"
                        onClick={() => {
                            setUseRecoveryCode((v) => !v);
                            setServerError(null);
                        }}
                    >
                        {useRecoveryCode ? tm('useTotp') : tm('useRecoveryCode')}
                    </button>
                    <button
                        type="button"
                        className="text-muted-foreground hover:underline"
                        onClick={() => {
                            setChallengeToken(null);
                            setServerError(null);
                        }}
                    >
                        {tm('backToLogin')}
                    </button>
                </div>
            </form>
        );
    }

    // ---- Step 1: credentials ----
    return (
        <form onSubmit={handleSubmit(onSubmit)} className="mt-8 flex flex-col gap-5" noValidate>
            <FormField
                label={t('email')}
                id="email"
                required
                error={errors.email ? t('errors.invalidEmail') : undefined}
            >
                <Input type="email" autoComplete="email" placeholder={t('emailPlaceholder')} {...register('email')} />
            </FormField>
            <FormField
                label={t('password')}
                id="password"
                required
                error={errors.password ? t('errors.passwordRequired') : undefined}
            >
                <Input
                    type="password"
                    autoComplete="current-password"
                    placeholder={t('passwordPlaceholder')}
                    {...register('password')}
                />
            </FormField>

            {serverError && (
                <p
                    role="alert"
                    className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-500 dark:text-red-300"
                >
                    {serverError}
                </p>
            )}

            <Button type="submit" size="lg" loading={isSubmitting} className="w-full">
                {isSubmitting ? t('submitting') : t('submit')}
            </Button>
        </form>
    );
}
