import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getSessionUser } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { BrandingClient } from '@/components/admin/branding-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('adminBranding') };
}

export default async function AdminBrandingPage() {
    const user = await getSessionUser();
    if (user?.role !== 'admin') return <AccessDenied />;
    return <BrandingClient />;
}
