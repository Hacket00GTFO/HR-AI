import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LoginForm } from '@/components/auth/login-form';
import { ThemeToggle } from '@/components/theme-toggle';
import { LocaleSwitcher } from '@/components/locale-switcher';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('login');
    return { title: t('title') };
}

// Branded split screen — CSS/gradient hero instead of the legacy 10MB video.
export default async function LoginPage() {
    const t = await getTranslations('login');
    return (
        <div className="grid min-h-dvh lg:grid-cols-2">
            {/* Hero */}
            <div
                aria-hidden="true"
                className="relative hidden overflow-hidden bg-navy-950 lg:flex lg:flex-col lg:justify-center lg:px-16"
            >
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(244,91,78,0.35),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(47,62,79,0.9),transparent_60%)]" />
                <div className="relative">
                    <p className="font-display text-4xl font-bold leading-tight text-white xl:text-5xl">
                        {t('heroTitle')}
                    </p>
                    <p className="mt-4 max-w-md text-lg text-slate-300">{t('heroSubtitle')}</p>
                </div>
            </div>

            {/* Form side — main landmark for the unauthenticated page. */}
            <main className="relative flex items-center justify-center px-4 py-12 sm:px-8">
                <div className="absolute right-4 top-4 flex items-center gap-1">
                    <LocaleSwitcher />
                    <ThemeToggle />
                </div>
                <div className="w-full max-w-md">
                    <p className="mb-8 text-center font-display text-2xl font-bold text-coral-600 dark:text-coral-500">
                        StraforAI
                    </p>
                    <h1 className="font-display text-2xl font-semibold">{t('title')}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
                    <LoginForm />
                </div>
            </main>
        </div>
    );
}
