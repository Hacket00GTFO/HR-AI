'use client';

import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Globe } from 'lucide-react';
import { setLocale } from '@/lib/locale-actions';
import { locales, type Locale } from '@/i18n/config';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

const LOCALE_LABEL: Record<Locale, string> = {
    'es-MX': 'spanish',
    en: 'english'
} as const;

const LOCALE_TAG: Record<Locale, string> = {
    'es-MX': 'es-MX',
    en: 'en'
};

export function LocaleSwitcher() {
    const t = useTranslations('common');
    const locale = useLocale();
    const [pending, startTransition] = useTransition();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('language')} title={t('language')} disabled={pending}>
                    <Globe className="size-5" aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {locales.map((l) => (
                    <DropdownMenuItem
                        key={l}
                        lang={LOCALE_TAG[l]}
                        onSelect={() => startTransition(() => setLocale(l))}
                        aria-current={locale === l ? 'true' : undefined}
                    >
                        <Check aria-hidden="true" className={locale === l ? 'opacity-100' : 'opacity-0'} />
                        {t(LOCALE_LABEL[l])}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
