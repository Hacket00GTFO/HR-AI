import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
    const t = useTranslations('notFound');
    return (
        <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
            <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
            <p className="max-w-md text-muted-foreground">{t('body')}</p>
            <Button asChild>
                <Link href="/dashboard">{t('back')}</Link>
            </Button>
        </main>
    );
}
