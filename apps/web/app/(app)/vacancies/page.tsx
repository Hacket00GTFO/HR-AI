import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VacanciesClient } from '@/components/vacancies/vacancies-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('vacancies') };
}

export default async function VacanciesPage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return <VacanciesClient />;
}
