import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DashboardClient } from '@/components/dashboard/dashboard-client';
import { AdminDashboardClient } from '@/components/dashboard/admin-dashboard-client';
import { getSessionUser } from '@/lib/session';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard');
    return { title: t('title') };
}

export default async function DashboardPage() {
    const t = await getTranslations('dashboard');
    const user = await getSessionUser();

    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
            {user?.role === 'admin' ? <AdminDashboardClient /> : <DashboardClient />}
        </div>
    );
}
