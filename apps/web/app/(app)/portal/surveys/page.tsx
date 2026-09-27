import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SurveysClient } from '@/components/portal/surveys-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.surveys');
    return { title: t('title') };
}

// HR survey console — create, open/close, and view k-anonymised results.
export default function PortalSurveysPage() {
    return <SurveysClient />;
}
