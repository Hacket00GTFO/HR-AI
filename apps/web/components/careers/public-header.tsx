import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ThemeToggle } from '@/components/theme-toggle';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Button } from '@/components/ui/button';

// Minimal public header for the careers surface (no AppShell — anonymous).
export async function PublicHeader() {
    const t = await getTranslations('careers');
    return (
        <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
            <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
                <Link href="/careers" className="font-display text-lg font-bold text-coral-600 dark:text-coral-500">
                    StraforAI
                </Link>
                <div className="flex items-center gap-1">
                    <LocaleSwitcher />
                    <ThemeToggle />
                    <Button asChild variant="ghost" size="sm">
                        <Link href="/login">{t('signIn')}</Link>
                    </Button>
                </div>
            </div>
        </header>
    );
}
