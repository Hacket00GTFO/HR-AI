import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TicketDetailClient } from '@/components/portal/ticket-detail-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.tickets');
    return { title: t('detailTitle') };
}

export default async function PortalTicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <TicketDetailClient ticketId={id} />;
}
