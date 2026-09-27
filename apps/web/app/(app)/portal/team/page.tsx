import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TeamClient } from '@/components/portal/team-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.team');
    return { title: t('title') };
}

// Manager team view — direct reports, leave balances, open anomalies.
export default function PortalTeamPage() {
    return <TeamClient />;
}
