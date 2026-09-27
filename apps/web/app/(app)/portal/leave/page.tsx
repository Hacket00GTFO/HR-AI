import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LeaveClient } from '@/components/portal/leave-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.leave');
    return { title: t('title') };
}

export default function PortalLeavePage() {
    return <LeaveClient />;
}
