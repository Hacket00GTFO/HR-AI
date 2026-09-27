'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
    ArrowRight,
    CalendarCheck,
    CalendarMinus,
    Package,
    Receipt,
    SearchX,
    Ticket as TicketIcon
} from 'lucide-react';
import { fetchJson } from '@/lib/http';
import { formatDate } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
    attendanceMineResponseSchema,
    expenseListResponseSchema,
    leaveBalancesResponseSchema,
    leaveTypesResponseSchema,
    ticketListResponseSchema,
    type AttendanceEvent,
    type ExpenseReport,
    type LeaveBalance,
    type LeaveType,
    type Ticket
} from './schemas';
import { expenseReportDisplayTotal, isToday, normalizeExpenseReports, normalizeTickets, reportDate } from './lib';

type Slice<T> = { state: 'loading' | 'error' | 'done'; data: T };

function loadingSlice<T>(data: T): Slice<T> {
    return { state: 'loading', data };
}

// Aggregates the employee's own data: leave balances, today's attendance,
// open tickets and pending expenses. Each card loads independently — a
// missing/unavailable upstream service degrades only its own card.
export function PortalDashboardClient() {
    const t = useTranslations('portal.dashboard');
    const tNav = useTranslations('portal.nav');
    const locale = useLocale();

    const [balances, setBalances] = React.useState<Slice<LeaveBalance[]>>(loadingSlice([]));
    const [leaveTypes, setLeaveTypes] = React.useState<LeaveType[]>([]);
    const [todayEvents, setTodayEvents] = React.useState<Slice<AttendanceEvent[]>>(loadingSlice([]));
    const [tickets, setTickets] = React.useState<Slice<Ticket[]>>(loadingSlice([]));
    const [expenses, setExpenses] = React.useState<Slice<ExpenseReport[]>>(loadingSlice([]));

    const load = React.useCallback(async () => {
        const settle = async <T,>(p: Promise<T>): Promise<Slice<T>> => {
            try {
                return { state: 'done', data: await p };
            } catch {
                return { state: 'error', data: undefined as T };
            }
        };

        const typesP = fetchJson('/api/proxy/leave/types', leaveTypesResponseSchema)
            .then((d) => setLeaveTypes(d.types))
            .catch(() => setLeaveTypes([]));
        const balancesP = settle(
            fetchJson('/api/proxy/leave/balances', leaveBalancesResponseSchema).then((d) => d.balances)
        ).then((s) => setBalances({ ...s, data: s.data ?? [] }));
        const eventsP = settle(fetchJson('/api/proxy/attendance/mine?limit=200', attendanceMineResponseSchema)).then(
            (s) => setTodayEvents({ ...s, data: (s.data?.events ?? []).filter((e) => isToday(e.occurredAt)) })
        );
        const ticketsP = settle(fetchJson('/api/proxy/tickets', ticketListResponseSchema).then(normalizeTickets)).then(
            (s) => setTickets({ ...s, data: s.data ?? [] })
        );
        const expensesP = settle(
            fetchJson('/api/proxy/expenses', expenseListResponseSchema).then(normalizeExpenseReports)
        ).then((s) => setExpenses({ ...s, data: s.data ?? [] }));

        await Promise.all([typesP, balancesP, eventsP, ticketsP, expensesP]);
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const typeName = (id: number) => leaveTypes.find((lt) => lt.id === id)?.name ?? `#${id}`;

    const openTickets = tickets.data.filter(
        (tk) => !['resolved', 'closed', 'cancelled'].includes(tk.status.toLowerCase())
    );
    const pendingExpenses = expenses.data.filter((r) =>
        ['draft', 'submitted', 'pending', 'in_review'].includes(r.status.toLowerCase())
    );
    const lastPunch = [...todayEvents.data].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
    const checkedIn = lastPunch?.kind === 'check_in' || lastPunch?.kind === 'break_end';

    const money = (n: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'MXN' }).format(n);
    const time = (iso: string) =>
        new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

    const cardError = (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SearchX className="size-3.5" aria-hidden="true" />
            {t('cardError')}
        </p>
    );

    return (
        <div className="flex flex-col gap-6">
            <header>
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
            </header>

            <div className="grid gap-4 sm:grid-cols-2">
                {/* Leave balances */}
                <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <CalendarMinus className="size-4 text-coral-600" aria-hidden="true" />
                            {t('leaveBalances')}
                        </CardTitle>
                        <Button asChild variant="ghost" size="sm">
                            <Link href="/portal/leave">
                                {t('viewAll')}
                                <ArrowRight className="size-3.5" aria-hidden="true" />
                            </Link>
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {balances.state === 'loading' ? (
                            <Skeleton className="h-16 rounded-lg" />
                        ) : balances.state === 'error' ? (
                            cardError
                        ) : balances.data.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t('noBalances')}</p>
                        ) : (
                            <ul className="flex flex-col gap-2">
                                {balances.data.map((b) => (
                                    <li
                                        key={`${b.leaveTypeId}-${b.year}`}
                                        className="flex items-baseline justify-between gap-2"
                                    >
                                        <span className="truncate text-sm">{typeName(b.leaveTypeId)}</span>
                                        <span className="shrink-0 font-display text-lg font-semibold">
                                            {t('daysLeft', { days: b.available })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>

                {/* Today's attendance */}
                <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <CalendarCheck className="size-4 text-coral-600" aria-hidden="true" />
                            {t('attendanceToday')}
                        </CardTitle>
                        <Button asChild variant="ghost" size="sm">
                            <Link href="/portal/attendance">
                                {t('viewAll')}
                                <ArrowRight className="size-3.5" aria-hidden="true" />
                            </Link>
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {todayEvents.state === 'loading' ? (
                            <Skeleton className="h-16 rounded-lg" />
                        ) : todayEvents.state === 'error' ? (
                            cardError
                        ) : todayEvents.data.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t('notCheckedIn')}</p>
                        ) : (
                            <div className="flex flex-col gap-1">
                                <p className="font-display text-lg font-semibold">
                                    {checkedIn ? t('checkedIn') : t('checkedOut')}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {t('punchCount', { count: todayEvents.data.length })}
                                    {lastPunch ? ` · ${t('lastAt', { time: time(lastPunch.occurredAt) })}` : ''}
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Open tickets */}
                <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <TicketIcon className="size-4 text-coral-600" aria-hidden="true" />
                            {t('openTickets')}
                        </CardTitle>
                        <Button asChild variant="ghost" size="sm">
                            <Link href="/portal/tickets">
                                {t('viewAll')}
                                <ArrowRight className="size-3.5" aria-hidden="true" />
                            </Link>
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {tickets.state === 'loading' ? (
                            <Skeleton className="h-16 rounded-lg" />
                        ) : tickets.state === 'error' ? (
                            cardError
                        ) : (
                            <p className="font-display text-3xl font-bold">{openTickets.length}</p>
                        )}
                    </CardContent>
                </Card>

                {/* Pending expenses */}
                <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Receipt className="size-4 text-coral-600" aria-hidden="true" />
                            {t('pendingExpenses')}
                        </CardTitle>
                        <Button asChild variant="ghost" size="sm">
                            <Link href="/portal/expenses">
                                {t('viewAll')}
                                <ArrowRight className="size-3.5" aria-hidden="true" />
                            </Link>
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {expenses.state === 'loading' ? (
                            <Skeleton className="h-16 rounded-lg" />
                        ) : expenses.state === 'error' ? (
                            cardError
                        ) : pendingExpenses.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t('noPendingExpenses')}</p>
                        ) : (
                            <div className="flex flex-col gap-1">
                                <p className="font-display text-3xl font-bold">{pendingExpenses.length}</p>
                                <p className="text-sm text-muted-foreground">
                                    {money(pendingExpenses.reduce((a, r) => a + expenseReportDisplayTotal(r), 0))}
                                    {' · '}
                                    {formatDate(reportDate(pendingExpenses[0] as ExpenseReport), locale)}
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* Quick actions */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">{t('quickActions')}</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        {(
                            [
                                { href: '/portal/attendance', key: 'attendance', icon: CalendarCheck },
                                { href: '/portal/leave', key: 'leave', icon: CalendarMinus },
                                { href: '/portal/tickets', key: 'tickets', icon: TicketIcon },
                                { href: '/portal/assets', key: 'assets', icon: Package }
                            ] as const
                        ).map((a) => (
                            <Link
                                key={a.key}
                                href={a.href}
                                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                            >
                                <a.icon className="size-4 text-coral-600" aria-hidden="true" />
                                {tNav(a.key)}
                            </Link>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
