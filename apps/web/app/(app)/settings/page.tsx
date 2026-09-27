import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SettingsClient } from '@/components/settings/settings-client';
import { getSessionUser } from '@/lib/session';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('nav');
    return { title: t('settings') };
}

export default async function SettingsPage() {
    const user = await getSessionUser();
    return <SettingsClient role={user?.role} />;
}
