import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getSessionUser } from '@/lib/session';
import { AdminClient } from '@/components/admin/admin-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('admin') };
}

export default async function AdminPage() {
    const user = await getSessionUser();
    const isAdmin = user?.role === 'admin';
    return <AdminClient isAdmin={isAdmin} />;
}
