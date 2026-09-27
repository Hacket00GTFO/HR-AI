import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CandidatesClient } from '@/components/candidates/candidates-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('candidates') };
}

export default async function CandidatesPage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return <CandidatesClient />;
}
