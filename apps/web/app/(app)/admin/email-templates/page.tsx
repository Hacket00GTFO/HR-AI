import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getSessionUser } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { EmailTemplateEditorClient } from '@/components/admin/email-template-editor-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('adminEmailTemplates') };
}

export default async function AdminEmailTemplatesPage() {
    const user = await getSessionUser();
    if (user?.role !== 'admin') return <AccessDenied />;
    return <EmailTemplateEditorClient />;
}
