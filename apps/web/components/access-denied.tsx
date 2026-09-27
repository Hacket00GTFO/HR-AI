import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

/** 403 view rendered when a role-guarded page is accessed by another role. */
export async function AccessDenied() {
    const t = await getTranslations('accessDenied');
    return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
            <div aria-hidden="true" className="text-muted-foreground [&_svg]:size-10">
                <ShieldAlert />
            </div>
            <p className="font-display text-lg font-semibold text-foreground">{t('title')}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t('body')}</p>
            <Link
                href="/dashboard"
                className="mt-2 rounded-md bg-coral-600 px-4 py-2 text-sm font-medium text-white hover:bg-coral-700"
            >
                {t('backToDashboard')}
            </Link>
        </div>
    );
}
