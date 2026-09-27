import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { OrgClient } from '@/components/portal/org-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.org');
    return { title: t('title') };
}

// Org chart — read-only department hierarchy (hr-core GET /v1/org/tree).
export default function PortalOrgPage() {
    return <OrgClient />;
}
