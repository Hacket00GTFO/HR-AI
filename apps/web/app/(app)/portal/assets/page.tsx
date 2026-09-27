import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AssetsClient } from '@/components/portal/assets-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('portal.assets');
    return { title: t('title') };
}

export default function PortalAssetsPage() {
    return <AssetsClient />;
}
