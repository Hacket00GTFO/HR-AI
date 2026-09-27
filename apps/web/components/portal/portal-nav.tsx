'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarCheck, CalendarMinus, LayoutGrid, Package, Receipt, Ticket } from 'lucide-react';
import { cn } from '@/lib/utils';

// Section tabs for the employee self-service portal. Mobile-first: a
// horizontally scrollable row of pills under the app topbar.
const SECTIONS = [
    { href: '/portal', key: 'dashboard', icon: LayoutGrid },
    { href: '/portal/attendance', key: 'attendance', icon: CalendarCheck },
    { href: '/portal/leave', key: 'leave', icon: CalendarMinus },
    { href: '/portal/tickets', key: 'tickets', icon: Ticket },
    { href: '/portal/expenses', key: 'expenses', icon: Receipt },
    { href: '/portal/assets', key: 'assets', icon: Package }
] as const;

export function PortalNav() {
    const t = useTranslations('portal.nav');
    const pathname = usePathname();

    return (
        <nav aria-label={t('label')} className="-mx-4 border-b border-border px-4 sm:-mx-6 sm:px-6">
            <ul className="flex gap-1 overflow-x-auto pb-px">
                {SECTIONS.map((s) => {
                    // '/portal' matches exactly; sub-sections match by prefix.
                    const active =
                        s.href === '/portal'
                            ? pathname === s.href
                            : pathname === s.href || pathname.startsWith(`${s.href}/`);
                    return (
                        <li key={s.key} className="shrink-0">
                            <Link
                                href={s.href}
                                {...(active ? { 'aria-current': 'page' as const } : {})}
                                className={cn(
                                    'flex items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                                    active
                                        ? 'border-coral-600 text-coral-600 dark:text-coral-400'
                                        : 'border-transparent text-muted-foreground hover:text-foreground'
                                )}
                            >
                                <s.icon className="size-4" aria-hidden="true" />
                                {t(s.key)}
                            </Link>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
