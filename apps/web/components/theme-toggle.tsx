'use client';

import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme();
    const t = useTranslations('common');
    const isDark = resolvedTheme === 'dark';
    return (
        <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            aria-label={t('toggleTheme')}
            title={t('toggleTheme')}
        >
            {/* Both icons rendered; CSS picks the visible one — no hydration flash. */}
            <Sun className="size-5 dark:hidden" aria-hidden="true" />
            <Moon className="hidden size-5 dark:block" aria-hidden="true" />
        </Button>
    );
}
