import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PortalDashboardClient } from '@/components/portal/dashboard-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.dashboard');
    return { title: t('title') };
}

// Employee self-service dashboard — aggregates own leave balances, today's
// attendance, open tickets and pending expenses.
export default function PortalPage() {
    return <PortalDashboardClient />;
}
