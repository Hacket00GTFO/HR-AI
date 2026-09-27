'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarMinus, Check, SearchX, X } from 'lucide-react';
import { toast } from 'sonner';
import { fetchJson, sendJson, errorMessage } from '@/lib/http';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { leaveRequestsResponseSchema, leaveTypesResponseSchema, type LeaveRequest, type LeaveType } from './schemas';
import {
    employeeDisplayName,
    normalizeTeamEmployees,
    teamEmployeesResponseSchema,
    type TeamEmployee
} from './team-lib';

type LoadState = 'loading' | 'error' | 'done';

// Aprobaciones de ausencias — pending leave-request queue for hr/manager.
// Verified upstream contract (time-attendance src/routes/leave.ts):
//   GET /v1/leave/requests?status=pending        → { requests }
//   PUT /v1/leave/requests/:id/approve|reject    → decided request (409 when
//                                                  already decided / balance
//                                                  insufficient)
// NOTEs:
//  - The decision endpoints are PUT (not POST) and currently accept NO body —
//    the reviewer comment is sent anyway ({ comment }) for forward-compat and
//    is ignored upstream until the route persists it.
//  - For non-hr callers the list endpoint is self-scoped upstream
//    (employeeFilter = own employeeId), so a manager sees only their own
//    pending requests until a manager-scoped filter exists.
//  - Employee names come from hr-core GET /v1/employees (hr-only); when that
//    call fails the row falls back to '#<employeeId>'.
export function ApprovalsLeaveClient() {
    const t = useTranslations('portal.approvals.leave');
    const tApprovals = useTranslations('portal.approvals');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [requests, setRequests] = React.useState<LeaveRequest[]>([]);
    const [types, setTypes] = React.useState<LeaveType[]>([]);
    const [employees, setEmployees] = React.useState<TeamEmployee[]>([]);
    const [state, setState] = React.useState<LoadState>('loading');
    const [comments, setComments] = React.useState<Record<string, string>>({});
    const [deciding, setDeciding] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const [reqs, typs, emps] = await Promise.all([
                fetchJson('/api/proxy/leave/requests?status=pending', leaveRequestsResponseSchema),
                fetchJson('/api/proxy/leave/types', leaveTypesResponseSchema).catch(() => ({
                    types: [] as LeaveType[]
                })),
                fetchJson('/api/proxy/employees', teamEmployeesResponseSchema)
                    .then(normalizeTeamEmployees)
                    .catch(() => [] as TeamEmployee[])
            ]);
            setRequests(reqs.requests);
            setTypes(typs.types);
            setEmployees(emps);
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const typeName = (id: number) => types.find((lt) => lt.id === id)?.name ?? `#${id}`;
    const employeeName = (id: LeaveRequest['employeeId']) => {
        const e = employees.find((x) => String(x.id) === String(id ?? ''));
        return e ? employeeDisplayName(e) : `#${String(id ?? '?')}`;
    };

    const decide = async (r: LeaveRequest, action: 'approve' | 'reject') => {
        const key = `${String(r.id)}:${action}`;
        setDeciding(key);
        try {
            const comment = comments[String(r.id)]?.trim();
            const { res, data } = await sendJson(`/api/proxy/leave/requests/${r.id}/${action}`, {
                method: 'PUT',
                body: comment ? { comment } : {}
            });
            if (res.ok) {
                toast.success(action === 'approve' ? t('approveOk') : t('rejectOk'));
                setRequests((list) => list.filter((x) => x.id !== r.id));
                return;
            }
            if (res.status === 409) toast.error(errorMessage(data) ?? t('errors.alreadyDecided'));
            else toast.error(errorMessage(data) ?? t('errors.generic'));
        } catch {
            toast.error(t('errors.generic'));
        } finally {
            setDeciding(null);
        }
    };

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
            ) : requests.length === 0 ? (
                <EmptyState icon={<CalendarMinus />} title={t('empty')} description={t('emptyHint')} />
            ) : (
                <ul className="flex flex-col gap-3">
                    {requests.map((r) => (
                        <li key={r.id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold">{employeeName(r.employeeId)}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {typeName(r.leaveTypeId)}
                                        {' · '}
                                        {formatDate(r.startDate, locale)} – {formatDate(r.endDate, locale)}
                                        {' · '}
                                        {t('days', { days: r.days })}
                                    </p>
                                    {r.reason && (
                                        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                                            {t('reason', { reason: r.reason })}
                                        </p>
                                    )}
                                </div>
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                <Input
                                    value={comments[String(r.id)] ?? ''}
                                    onChange={(e) => setComments((c) => ({ ...c, [String(r.id)]: e.target.value }))}
                                    placeholder={t('commentPlaceholder')}
                                    maxLength={2000}
                                    aria-label={tApprovals('comment')}
                                    className="sm:max-w-xs"
                                />
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        loading={deciding === `${String(r.id)}:approve`}
                                        disabled={deciding !== null}
                                        onClick={() => decide(r, 'approve')}
                                        aria-label={t('approveFor', { name: employeeName(r.employeeId) })}
                                    >
                                        <Check aria-hidden="true" />
                                        {t('approve')}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="danger"
                                        loading={deciding === `${String(r.id)}:reject`}
                                        disabled={deciding !== null}
                                        onClick={() => decide(r, 'reject')}
                                        aria-label={t('rejectFor', { name: employeeName(r.employeeId) })}
                                    >
                                        <X aria-hidden="true" />
                                        {t('reject')}
                                    </Button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
