'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
    Activity,
    BarChart3,
    Bell,
    Briefcase,
    CalendarCheck,
    CalendarMinus,
    Check,
    ChevronsLeft,
    ChevronsRight,
    ClipboardList,
    Database,
    FileSearch,
    Flag,
    GitBranch,
    GraduationCap,
    Heart,
    Key,
    Languages,
    LayoutDashboard,
    LayoutGrid,
    Layers,
    Lock,
    LogOut,
    Mail,
    Menu,
    Network,
    Package,
    Palette,
    Receipt,
    Search,
    Settings,
    ShieldCheck,
    Ticket,
    TrendingUp,
    Users,
    Wallet,
    Webhook,
    X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { setLocale } from '@/lib/locale-actions';
import { locales, type Locale } from '@/i18n/config';
import type { AppRole } from '@/lib/roles';
import { ThemeToggle } from '@/components/theme-toggle';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import type { SessionUser } from '@/lib/auth';

/* ---------------- role-based navigation model ---------------- */

interface NavItemDef {
    href: string;
    /** Key under the `nav` messages namespace. */
    key: string;
    icon: React.ReactNode;
    /** Match only the exact pathname (for section roots like /admin). */
    exact?: boolean;
}

interface NavGroupDef {
    /** Key under `nav.groups` — null renders items without a heading. */
    key: string | null;
    items: NavItemDef[];
}

const icon = (node: React.ReactNode) => node;

// Grouped menu per role. Rendering gate only — services enforce access.
const NAV_BY_ROLE: Record<AppRole, NavGroupDef[]> = {
    // Technical administration: dashboards + ops tooling. No HR business items.
    admin: [
        {
            key: null,
            items: [
                { href: '/dashboard', key: 'dashboard', icon: icon(<LayoutDashboard aria-hidden="true" />) },
                { href: '/admin/monitoring', key: 'adminMonitoring', icon: icon(<BarChart3 aria-hidden="true" />) }
            ]
        },
        {
            key: 'adminTech',
            items: [
                { href: '/admin', key: 'admin', icon: icon(<ShieldCheck aria-hidden="true" />), exact: true },
                { href: '/admin/audit', key: 'adminAudit', icon: icon(<FileSearch aria-hidden="true" />) },
                { href: '/admin/jobs', key: 'adminJobs', icon: icon(<Briefcase aria-hidden="true" />) },
                { href: '/admin/health', key: 'adminHealth', icon: icon(<Activity aria-hidden="true" />) },
                { href: '/admin/api-keys', key: 'adminApiKeys', icon: icon(<Key aria-hidden="true" />) },
                {
                    href: '/admin/feature-flags',
                    key: 'adminFeatureFlags',
                    icon: icon(<Flag aria-hidden="true" />)
                },
                {
                    href: '/admin/email-templates',
                    key: 'adminEmailTemplates',
                    icon: icon(<Mail aria-hidden="true" />)
                },
                {
                    href: '/admin/data-retention',
                    key: 'adminDataRetention',
                    icon: icon(<Database aria-hidden="true" />)
                },
                { href: '/admin/notifications', key: 'adminNotifications', icon: icon(<Bell aria-hidden="true" />) },
                { href: '/admin/analytics', key: 'adminAnalytics', icon: icon(<TrendingUp aria-hidden="true" />) },
                { href: '/admin/webhooks', key: 'adminWebhooks', icon: icon(<Webhook aria-hidden="true" />) },
                { href: '/admin/approvals', key: 'adminApprovals', icon: icon(<GitBranch aria-hidden="true" />) },
                { href: '/admin/ip-allowlist', key: 'adminIpAllowlist', icon: icon(<Lock aria-hidden="true" />) },
                { href: '/admin/branding', key: 'adminBranding', icon: icon(<Palette aria-hidden="true" />) },
                { href: '/admin/bulk', key: 'adminBulk', icon: icon(<Layers aria-hidden="true" />) }
            ]
        }
    ],
    // HR business navigation: recruiting, people, time, payroll, HR services.
    hr: [
        {
            key: null,
            items: [{ href: '/dashboard', key: 'dashboard', icon: icon(<LayoutDashboard aria-hidden="true" />) }]
        },
        {
            key: 'recruitment',
            items: [
                { href: '/vacancies', key: 'vacancies', icon: icon(<Briefcase aria-hidden="true" />) },
                { href: '/candidates', key: 'candidates', icon: icon(<Users aria-hidden="true" />) }
            ]
        },
        {
            key: 'people',
            items: [
                { href: '/employees', key: 'employees', icon: icon(<Users aria-hidden="true" />) },
                { href: '/portal/org', key: 'orgChart', icon: icon(<Network aria-hidden="true" />) },
                { href: '/performance', key: 'performance', icon: icon(<TrendingUp aria-hidden="true" />) },
                { href: '/training', key: 'training', icon: icon(<GraduationCap aria-hidden="true" />) }
            ]
        },
        {
            key: 'time',
            items: [
                { href: '/attendance', key: 'attendance', icon: icon(<CalendarCheck aria-hidden="true" />) },
                { href: '/leave', key: 'leave', icon: icon(<CalendarMinus aria-hidden="true" />) }
            ]
        },
        {
            key: 'payroll',
            items: [
                { href: '/payroll', key: 'payroll', icon: icon(<Wallet aria-hidden="true" />) },
                { href: '/benefits', key: 'benefits', icon: icon(<Heart aria-hidden="true" />) }
            ]
        },
        {
            key: 'hrServices',
            items: [
                { href: '/portal/tickets', key: 'tickets', icon: icon(<Ticket aria-hidden="true" />) },
                { href: '/portal/assets', key: 'assets', icon: icon(<Package aria-hidden="true" />) },
                { href: '/portal/expenses', key: 'expenses', icon: icon(<Receipt aria-hidden="true" />) },
                { href: '/portal/surveys', key: 'surveys', icon: icon(<ClipboardList aria-hidden="true" />) }
            ]
        }
    ],
    // People managers: team overview + approval queues.
    manager: [
        {
            key: null,
            items: [{ href: '/dashboard', key: 'dashboard', icon: icon(<LayoutDashboard aria-hidden="true" />) }]
        },
        {
            key: 'myTeam',
            items: [{ href: '/portal/team', key: 'team', icon: icon(<Users aria-hidden="true" />) }]
        },
        {
            key: 'approvals',
            items: [
                {
                    href: '/portal/approvals/leave',
                    key: 'leaveApprovals',
                    icon: icon(<CalendarMinus aria-hidden="true" />)
                },
                {
                    href: '/portal/approvals/expenses',
                    key: 'expenseApprovals',
                    icon: icon(<Receipt aria-hidden="true" />)
                }
            ]
        }
    ],
    // Employees land on the self-service portal.
    employee: [
        {
            key: null,
            items: [{ href: '/portal', key: 'portal', icon: icon(<LayoutGrid aria-hidden="true" />) }]
        }
    ],
    // Candidates use the public careers site — minimal shell nav.
    candidate: []
};

const SETTINGS_ITEM: NavItemDef = { href: '/settings', key: 'settings', icon: <Settings aria-hidden="true" /> };

const LOCALE_LABEL: Record<Locale, string> = {
    'es-MX': 'spanish',
    en: 'english'
};

function NavLink({
    item,
    collapsed,
    onNavigate
}: {
    item: NavItemDef;
    collapsed: boolean;
    onNavigate?: (() => void) | undefined;
}) {
    const t = useTranslations('nav');
    const pathname = usePathname();
    const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

    return (
        <Link
            href={item.href}
            {...(onNavigate ? { onClick: onNavigate } : {})}
            {...(active ? { 'aria-current': 'page' as const } : {})}
            {...(collapsed ? { title: t(item.key) } : {})}
            className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                    ? 'bg-coral-600/10 text-coral-600 dark:text-coral-400'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                collapsed && 'justify-center px-2'
            )}
        >
            <span className="[&_svg]:size-5">{item.icon}</span>
            {!collapsed && <span>{t(item.key)}</span>}
        </Link>
    );
}

function NavLinks({
    collapsed,
    role,
    onNavigate
}: {
    collapsed: boolean;
    role: AppRole | null;
    onNavigate?: () => void;
}) {
    const t = useTranslations('nav');
    // Unique prefix per nav instance — the desktop sidebar and the mobile
    // drawer can both be mounted, so group label ids must not collide.
    const idPrefix = React.useId();
    const groups = role ? NAV_BY_ROLE[role] : [];

    return (
        <ul className="flex flex-col gap-1">
            {groups.map((group, gi) => {
                const labelId = group.key ? `${idPrefix}-group-${group.key}` : undefined;
                return (
                    <li key={group.key ?? `top-${gi}`}>
                        {group.key &&
                            (collapsed ? (
                                <div aria-hidden="true" className="mx-1 my-2 border-t border-border" />
                            ) : (
                                <p
                                    id={labelId}
                                    className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                                >
                                    {t(`groups.${group.key}`)}
                                </p>
                            ))}
                        <ul
                            className="flex flex-col gap-1"
                            {...(labelId && !collapsed ? { 'aria-labelledby': labelId } : {})}
                        >
                            {group.items.map((item) => (
                                <li key={item.key}>
                                    <NavLink item={item} collapsed={collapsed} onNavigate={onNavigate} />
                                </li>
                            ))}
                        </ul>
                    </li>
                );
            })}
            <li>
                <div aria-hidden="true" className="mx-1 my-2 border-t border-border" />
                <NavLink item={SETTINGS_ITEM} collapsed={collapsed} onNavigate={onNavigate} />
            </li>
        </ul>
    );
}

function UserMenu({ user }: { user: SessionUser | null }) {
    const t = useTranslations('nav');
    const tCommon = useTranslations('common');
    const locale = useLocale();
    const router = useRouter();
    const [pending, startTransition] = React.useTransition();
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || '—';

    const logout = async () => {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } finally {
            router.push('/login');
            router.refresh();
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={t('userMenu')} className="gap-2">
                    <span
                        aria-hidden="true"
                        className="flex size-7 items-center justify-center rounded-full bg-navy-900 text-xs font-semibold text-white dark:bg-navy-700"
                    >
                        {(user?.firstName?.[0] ?? user?.email?.[0] ?? 'S').toUpperCase()}
                    </span>
                    <span className="hidden max-w-32 truncate md:inline">{name}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>{user?.email ?? ''}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="flex items-center gap-2">
                    <Languages aria-hidden="true" />
                    {tCommon('language')}
                </DropdownMenuLabel>
                {locales.map((l) => (
                    <DropdownMenuItem
                        key={l}
                        lang={l}
                        disabled={pending}
                        onSelect={() => startTransition(() => setLocale(l))}
                        aria-current={locale === l ? 'true' : undefined}
                    >
                        <Check aria-hidden="true" className={locale === l ? 'opacity-100' : 'opacity-0'} />
                        {tCommon(LOCALE_LABEL[l])}
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={logout}>
                    <LogOut aria-hidden="true" />
                    {t('logout')}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AppShell({
    children,
    user,
    role
}: {
    children: React.ReactNode;
    user: SessionUser | null;
    role: AppRole | null;
}) {
    const t = useTranslations('nav');
    const tCommon = useTranslations('common');
    const [collapsed, setCollapsed] = React.useState(false);
    const [drawerOpen, setDrawerOpen] = React.useState(false);
    const drawerRef = React.useRef<HTMLElement | null>(null);
    const menuButtonRef = React.useRef<HTMLButtonElement | null>(null);

    // Mobile drawer behavior: initial focus inside, Tab/Shift+Tab trapped,
    // Esc closes, focus returns to the trigger button on close.
    React.useEffect(() => {
        if (!drawerOpen) return;
        const drawer = drawerRef.current;
        if (!drawer) return;
        // Capture the trigger node now — the ref may have been reassigned by
        // the time this cleanup runs.
        const trigger = menuButtonRef.current;

        const focusables = () => Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));
        focusables()[0]?.focus();

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                setDrawerOpen(false);
                return;
            }
            if (e.key !== 'Tab') return;
            const els = focusables();
            if (els.length === 0) return;
            const first = els[0]!;
            const last = els[els.length - 1]!;
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            trigger?.focus();
        };
    }, [drawerOpen]);

    return (
        <div className="min-h-dvh">
            <a
                href="#main"
                className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-coral-600 focus:px-4 focus:py-2 focus:text-white"
            >
                {t('skipToContent')}
            </a>

            {/* Sidebar — desktop */}
            <aside
                className={cn(
                    'fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-border bg-card transition-[width] md:flex',
                    collapsed ? 'w-16' : 'w-60'
                )}
            >
                <div className="flex h-16 items-center gap-2 border-b border-border px-4">
                    <span className="font-display text-lg font-bold text-coral-600 dark:text-coral-500">
                        {collapsed ? 'S' : 'StraforAI'}
                    </span>
                </div>
                <nav aria-label={t('primaryNav')} className="flex-1 overflow-y-auto p-3">
                    <NavLinks collapsed={collapsed} role={role} />
                </nav>
                <div className="border-t border-border p-3">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-center"
                        onClick={() => setCollapsed((c) => !c)}
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? t('openMenu') : t('closeMenu')}
                    >
                        {collapsed ? <ChevronsRight aria-hidden="true" /> : <ChevronsLeft aria-hidden="true" />}
                    </Button>
                </div>
            </aside>

            {/* Mobile drawer — dialog semantics + focus trap (see effect above). */}
            {drawerOpen && (
                <div className="fixed inset-0 z-50 md:hidden">
                    <button
                        type="button"
                        aria-label={t('closeMenu')}
                        className="absolute inset-0 bg-navy-950/60"
                        onClick={() => setDrawerOpen(false)}
                    />
                    <aside
                        ref={drawerRef}
                        id="mobile-nav"
                        role="dialog"
                        aria-modal="true"
                        aria-label={t('primaryNav')}
                        className="absolute inset-y-0 left-0 w-64 overflow-y-auto border-r border-border bg-card p-4"
                    >
                        <div className="mb-4 flex items-center justify-between">
                            <span className="font-display text-lg font-bold text-coral-600 dark:text-coral-500">
                                StraforAI
                            </span>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setDrawerOpen(false)}
                                aria-label={t('closeMenu')}
                            >
                                <X aria-hidden="true" />
                            </Button>
                        </div>
                        <nav>
                            <NavLinks collapsed={false} role={role} onNavigate={() => setDrawerOpen(false)} />
                        </nav>
                    </aside>
                </div>
            )}

            <div className={cn('flex min-h-dvh flex-col transition-[margin] md:ml-60', collapsed && 'md:ml-16')}>
                {/* Topbar */}
                <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-card/90 px-4 backdrop-blur">
                    <Button
                        ref={menuButtonRef}
                        variant="ghost"
                        size="icon"
                        className="md:hidden"
                        onClick={() => setDrawerOpen((o) => !o)}
                        aria-expanded={drawerOpen}
                        aria-controls="mobile-nav"
                        aria-label={drawerOpen ? t('closeMenu') : t('openMenu')}
                    >
                        <Menu aria-hidden="true" />
                    </Button>
                    <div className="relative hidden max-w-sm flex-1 sm:block">
                        <Search
                            aria-hidden="true"
                            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        />
                        <input
                            type="search"
                            placeholder={tCommon('search')}
                            aria-label={tCommon('search')}
                            className="h-9 w-full rounded-md border border-border bg-input pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        />
                    </div>
                    <div className="ml-auto flex items-center gap-1">
                        <Button variant="ghost" size="icon" aria-label={t('notifications')} title={t('notifications')}>
                            <Bell className="size-5" aria-hidden="true" />
                        </Button>
                        <ThemeToggle />
                        <LocaleSwitcher />
                        <UserMenu user={user} />
                    </div>
                </header>

                <main id="main" className="flex-1 p-4 sm:p-6">
                    {children}
                </main>

                <footer className="border-t border-border px-6 py-4 text-xs text-muted-foreground">
                    StraforAI © {new Date().getFullYear()}
                </footer>
            </div>
        </div>
    );
}
