import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getSessionUser } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { ApiKeysClient } from '@/components/admin/api-keys-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('adminApiKeys') };
}

export default async function AdminApiKeysPage() {
    const user = await getSessionUser();
    if (user?.role !== 'admin') return <AccessDenied />;
    return <ApiKeysClient />;
}
