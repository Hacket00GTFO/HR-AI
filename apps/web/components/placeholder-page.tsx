import { getTranslations } from 'next-intl/server';
import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

// Interim stand-in for sections still owned by the legacy UI.
export async function PlaceholderPage({ titleKey }: { titleKey: 'employees' }) {
    const t = await getTranslations('placeholder');
    const tNav = await getTranslations('nav');
    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-bold">{tNav(titleKey)}</h1>
            <EmptyState icon={<Construction />} title={t('title')} description={t('body')} />
        </div>
    );
}
