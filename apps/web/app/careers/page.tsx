import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { fetchVacancies } from '@/lib/data';
import { PublicHeader } from '@/components/careers/public-header';
import { CareersBrowser } from '@/components/careers/careers-browser';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('careers');
    return { title: t('title') };
}

// Public careers board — vacancies fetched server-side (revalidate 60s);
// filtering is client-side; the browser retries via /api/vacancies on error.
export default async function CareersPage() {
    const t = await getTranslations('careers');
    const { data, error } = await fetchVacancies();

    return (
        <div className="min-h-dvh">
            <PublicHeader />
            <main id="main">
                {/* Hero — gradient, not a video */}
                <div className="bg-navy-950 px-4 py-16 text-center sm:py-20">
                    <div className="mx-auto max-w-3xl">
                        <h1 className="font-display text-4xl font-bold text-white sm:text-5xl">{t('title')}</h1>
                        <p className="mt-4 text-lg text-slate-300">{t('subtitle')}</p>
                    </div>
                </div>
                <div className="-mt-6 pt-6">
                    <CareersBrowser initialVacancies={data} initialError={error} />
                </div>
            </main>
            <footer className="border-t border-border px-6 py-6 text-center text-xs text-muted-foreground">
                StraforAI © {new Date().getFullYear()}
            </footer>
        </div>
    );
}
