import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getSessionUser } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { AuditLogClient } from '@/components/admin/audit-log-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('adminAudit') };
}

export default async function AdminAuditPage() {
    const user = await getSessionUser();
    if (user?.role !== 'admin') return <AccessDenied />;
    return <AuditLogClient />;
}
