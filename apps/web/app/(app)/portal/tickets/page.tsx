import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TicketsClient } from '@/components/portal/tickets-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.tickets');
    return { title: t('title') };
}

export default function PortalTicketsPage() {
    return <TicketsClient />;
}
