'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';

type Step = 'loading' | 'scan' | 'done';

interface SetupData {
    secret: string;
    qrCodeUrl: string;
}

/**
 * Minimal MFA enrollment wizard, reached when login returns
 * mfa_setup_required (the session cookie is already set — the user is
 * authenticated but not yet enrolled).
 *
 *  1. POST /api/proxy/auth/mfa/setup  → {secret, qrCodeUrl(otpauth URI)}
 *  2. user enters the 6-digit code from their authenticator
 *  3. POST /api/proxy/auth/mfa/confirm → {enabled, recoveryCodes} (shown once)
 *
 * NOTE: qrCodeUrl is an otpauth:// URI, not an image — there is no QR package
 * in this app yet, so we display the secret for manual entry. Adding `qrcode`
 * to render `qrCodeUrl` as an SVG is a drop-in follow-up.
 */
export function MfaEnrollForm() {
    const t = useTranslations('mfa');
    const router = useRouter();
    const [step, setStep] = React.useState<Step>('loading');
    const [setup, setSetup] = React.useState<SetupData | null>(null);
    const [code, setCode] = React.useState('');
    const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [submitting, setSubmitting] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/proxy/auth/mfa/setup', { method: 'POST' });
                if (res.status === 401) {
                    router.replace('/login?next=/mfa/setup');
                    return;
                }
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.secret) {
                    if (!cancelled) setError(t('errors.setupFailed'));
                    return;
                }
                if (!cancelled) {
                    setSetup({ secret: data.secret, qrCodeUrl: data.qrCodeUrl });
                    setStep('scan');
                }
            } catch {
                if (!cancelled) setError(t('errors.setupFailed'));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [router, t]);

    const onConfirm = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSubmitting(true);
        try {
            const res = await fetch('/api/proxy/auth/mfa/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(res.status === 400 ? t('errors.invalidCode') : t('errors.generic'));
                return;
            }
            setRecoveryCodes(Array.isArray(data.recoveryCodes) ? data.recoveryCodes : []);
            setStep('done');
        } catch {
            setError(t('errors.generic'));
        } finally {
            setSubmitting(false);
        }
    };

    if (step === 'loading') {
        return <p className="mt-8 text-sm text-muted-foreground">{t('loading')}</p>;
    }

    if (step === 'done') {
        return (
            <div className="mt-8 flex flex-col gap-5">
                <p className="text-sm text-muted-foreground">{t('recoveryIntro')}</p>
                <ul className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/40 p-4 font-mono text-sm">
                    {recoveryCodes.map((c) => (
                        <li key={c}>{c}</li>
                    ))}
                </ul>
                <p className="text-xs text-muted-foreground">{t('recoveryWarning')}</p>
                <Button size="lg" className="w-full" onClick={() => router.push('/dashboard')}>
                    {t('continue')}
                </Button>
            </div>
        );
    }

    return (
        <form onSubmit={onConfirm} className="mt-8 flex flex-col gap-5" noValidate>
            <p className="text-sm text-muted-foreground">{t('scanPrompt')}</p>
            {setup && (
                <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-4">
                    <p className="text-xs font-medium text-muted-foreground">{t('manualEntry')}</p>
                    <p className="break-all font-mono text-sm">{setup.secret}</p>
                    <p className="break-all font-mono text-xs text-muted-foreground">{setup.qrCodeUrl}</p>
                </div>
            )}
            <FormField label={t('codeLabel')} id="enroll-code" required>
                <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={t('codePlaceholder')}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                />
            </FormField>

            {error && (
                <p
                    role="alert"
                    className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-500 dark:text-red-300"
                >
                    {error}
                </p>
            )}

            <Button type="submit" size="lg" loading={submitting} disabled={!code.trim()} className="w-full">
                {submitting ? t('verifying') : t('verifyAndEnable')}
            </Button>
        </form>
    );
}
