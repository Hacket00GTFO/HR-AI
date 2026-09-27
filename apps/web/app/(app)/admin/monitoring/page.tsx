import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getSessionUser } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { MonitoringClient } from '@/components/admin/monitoring-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('adminMonitoring') };
}

export default async function AdminMonitoringPage() {
    const user = await getSessionUser();
    if (user?.role !== 'admin') return <AccessDenied />;
    return <MonitoringClient />;
}
