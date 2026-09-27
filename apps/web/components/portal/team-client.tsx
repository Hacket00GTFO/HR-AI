'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CalendarMinus, SearchX, Users } from 'lucide-react';
import { fetchJson } from '@/lib/http';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { PortalStatusBadge } from './portal-status-badge';
import { leaveBalancesResponseSchema, leaveTypesResponseSchema, type LeaveBalance, type LeaveType } from './schemas';
import {
    attendanceCorrectionsResponseSchema,
    balanceSummaryParts,
    callerEmployeeId,
    employeeDisplayName,
    normalizeCorrections,
    normalizeTeamEmployees,
    pendingCorrectionsFor,
    sessionUserResponseSchema,
    teamEmployeesResponseSchema,
    type AttendanceCorrection,
    type TeamEmployee
} from './team-lib';

type LoadState = 'loading' | 'error' | 'done';

// Mi equipo — a manager's direct reports at a glance.
// Upstream: GET /api/proxy/employees?managerId=<me> (hr-core; HR-only today —
// see team-lib NOTE), /api/proxy/leave/{balances,types} and
// /api/proxy/attendance/corrections?status=pending (time-attendance; reviewers
// see all). The auxiliary calls are fault-tolerant: a 403/404 on balances or
// corrections degrades that column instead of failing the page.
export function TeamClient() {
    const t = useTranslations('portal.team');
    const tCommon = useTranslations('common');
    useLocale();

    const [members, setMembers] = React.useState<TeamEmployee[]>([]);
    const [balances, setBalances] = React.useState<LeaveBalance[] | null>(null);
    const [types, setTypes] = React.useState<LeaveType[]>([]);
    const [corrections, setCorrections] = React.useState<AttendanceCorrection[] | null>(null);
    const [state, setState] = React.useState<LoadState>('loading');

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const me = await fetchJson('/api/auth/me', sessionUserResponseSchema);
            const employeeId = callerEmployeeId(me.user) ?? 'me';
            // Both spellings sent: hr-core's allowlist uses managerId, the
            // documented portal contract used manager_id — unknown keys are
            // skipped upstream.
            const empData = await fetchJson(
                `/api/proxy/employees?managerId=${encodeURIComponent(String(employeeId))}&manager_id=${encodeURIComponent(String(employeeId))}`,
                teamEmployeesResponseSchema
            );
            setMembers(normalizeTeamEmployees(empData));

            const [bal, typs, corr] = await Promise.all([
                fetchJson('/api/proxy/leave/balances', leaveBalancesResponseSchema).catch(() => null),
                fetchJson('/api/proxy/leave/types', leaveTypesResponseSchema).catch(() => null),
                fetchJson(
                    '/api/proxy/attendance/corrections?status=pending',
                    attendanceCorrectionsResponseSchema
                ).catch(() => null)
            ]);
            setBalances(bal?.balances ?? null);
            setTypes(typs?.types ?? []);
            setCorrections(corr ? normalizeCorrections(corr) : null);
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const typeName = (id: number) => types.find((lt) => lt.id === id)?.name ?? `#${id}`;

    return (
        <div className="flex flex-col gap-6">
            <header>
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
            </header>

            {state === 'loading' ? (
                <div aria-busy="true" className="flex flex-col gap-2">
                    {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-24 rounded-lg" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : members.length === 0 ? (
                <EmptyState icon={<Users />} title={t('empty')} description={t('emptyHint')} />
            ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                    {members.map((m) => {
                        const memberBalances = balances
                            ? balances.filter((b) => String(b.employeeId) === String(m.id))
                            : [];
                        const summary = balanceSummaryParts(memberBalances, typeName);
                        const anomalies = corrections ? pendingCorrectionsFor(corrections, m.id) : [];
                        return (
                            <li
                                key={String(m.id)}
                                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold">{employeeDisplayName(m)}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {[m.position, m.department].filter(Boolean).join(' · ') || t('noPosition')}
                                        </p>
                                    </div>
                                    <PortalStatusBadge status={m.status} />
                                </div>

                                <div className="flex flex-col gap-1.5 text-xs">
                                    <p className="flex items-center gap-1.5 text-muted-foreground">
                                        <CalendarMinus className="size-3.5 shrink-0" aria-hidden="true" />
                                        {balances === null
                                            ? t('balancesUnavailable')
                                            : summary.length === 0
                                              ? t('noBalances')
                                              : summary
                                                    .map((s) => t('balanceItem', { days: s.available, type: s.label }))
                                                    .join(' · ')}
                                    </p>
                                    <p className="flex items-center gap-1.5">
                                        <AlertTriangle
                                            className={
                                                anomalies.length > 0
                                                    ? 'size-3.5 shrink-0 text-warning-500'
                                                    : 'size-3.5 shrink-0 text-muted-foreground'
                                            }
                                            aria-hidden="true"
                                        />
                                        {corrections === null ? (
                                            <span className="text-muted-foreground">{t('anomaliesUnavailable')}</span>
                                        ) : anomalies.length === 0 ? (
                                            <span className="text-muted-foreground">{t('noAnomalies')}</span>
                                        ) : (
                                            <Badge variant="warning">
                                                {t('anomalyCount', { count: anomalies.length })}
                                            </Badge>
                                        )}
                                    </p>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
