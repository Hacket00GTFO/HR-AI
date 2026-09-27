import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MfaEnrollForm } from '@/components/auth/mfa-enroll-form';
import { ThemeToggle } from '@/components/theme-toggle';
import { LocaleSwitcher } from '@/components/locale-switcher';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('mfa');
    return { title: t('setupTitle') };
}

// Forced MFA enrollment — reached when login returns mfa_setup_required.
// The session cookie is already set, so this page sits behind the middleware
// auth gate like the rest of the app shell.
export default async function MfaSetupPage() {
    const t = await getTranslations('mfa');
    return (
        <main className="relative flex min-h-dvh items-center justify-center px-4 py-12 sm:px-8">
            <div className="absolute right-4 top-4 flex items-center gap-1">
                <LocaleSwitcher />
                <ThemeToggle />
            </div>
            <div className="w-full max-w-md">
                <p className="mb-8 text-center font-display text-2xl font-bold text-coral-600 dark:text-coral-500">
                    StraforAI
                </p>
                <h1 className="font-display text-2xl font-semibold">{t('setupTitle')}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t('setupSubtitle')}</p>
                <MfaEnrollForm />
            </div>
        </main>
    );
}
