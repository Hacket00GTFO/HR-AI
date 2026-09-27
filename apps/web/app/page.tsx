import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { fetchVacancies } from '@/lib/data';
import { CandidateHeader } from '@/components/portal/candidate-header';
import { CandidateJobsClient } from '@/components/portal/candidate-jobs-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.candidate');
    return { title: t('title') };
}

// Public candidate portal — anonymous vacancy listing. Server-side fetch
// (60s revalidate) with a client-side retry via /api/vacancies.
//
// NOTE: middleware currently protects /portal/* — anonymous reachability
// requires adding '/portal/candidato' to PUBLIC_PREFIXES in middleware.ts
// (owned by the shell agent — reported to parent).
export default async function CandidatePortalPage() {
    const t = await getTranslations('portal.candidate');
    const { data, error } = await fetchVacancies();

    return (
        <div className="min-h-dvh">
            <CandidateHeader />
            <main id="main">
                <div className="bg-navy-950 px-4 py-14 text-center sm:py-16">
                    <div className="mx-auto max-w-3xl">
                        <h1 className="font-display text-3xl font-bold text-white sm:text-4xl">{t('title')}</h1>
                        <p className="mt-3 text-base text-slate-300 sm:text-lg">{t('subtitle')}</p>
                    </div>
                </div>
                <div className="-mt-6 pt-6">
                    <CandidateJobsClient initialVacancies={data} initialError={error} />
                </div>
            </main>
            <footer className="border-t border-border px-6 py-6 text-center text-xs text-muted-foreground">
                StraforAI © {new Date().getFullYear()}
            </footer>
        </div>
    );
}
