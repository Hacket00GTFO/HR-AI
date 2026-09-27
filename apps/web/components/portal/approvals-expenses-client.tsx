'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Receipt, SearchX, X } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { fetchJson, sendJson, errorMessage } from '@/lib/http';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { expenseItemSchema, expenseListResponseSchema, type ExpenseReport } from './schemas';
import { expenseReportDisplayTotal, normalizeExpenseReports, reportDate, reportTitle } from './lib';
import {
    employeeDisplayName,
    normalizeTeamEmployees,
    teamEmployeesResponseSchema,
    type TeamEmployee
} from './team-lib';

type LoadState = 'loading' | 'error' | 'done';

// Report detail: GET /v1/expenses/:id → rowToReport + { items, approvals }.
const expenseApprovalSchema = z
    .object({
        id: z.union([z.number(), z.string()]).optional(),
        approverUserId: z.union([z.number(), z.string()]).nullable().optional().default(null),
        decision: z.string().optional().default(''),
        comment: z.string().nullable().optional().default(null),
        decidedAt: z.string().nullable().optional().default(null)
    })
    .loose();

const expenseDetailSchema = z
    .object({
        id: z.union([z.number(), z.string()]),
        employeeId: z.union([z.number(), z.string()]).optional(),
        title: z.string().optional().default(''),
        status: z.string().optional().default('submitted'),
        currency: z.string().optional().default('MXN'),
        total: z.coerce.number().nullable().optional().default(null),
        submittedAt: z.string().nullable().optional().default(null),
        items: z.array(expenseItemSchema).optional().default([]),
        approvals: z.array(expenseApprovalSchema).optional().default([])
    })
    .loose();
type ExpenseDetail = z.infer<typeof expenseDetailSchema>;

// Aprobaciones de viáticos — submitted expense reports for hr review.
// Verified upstream contract (hr-services src/routes/expenses.ts, HR-only):
//   GET  /v1/expenses?status=submitted   → ExpenseReport[] (bare array)
//   GET  /v1/expenses/:id                → report + items + approvals
//   POST /v1/expenses/:id/decide         { decision: 'approved'|'rejected',
//                                          comment?: string } → 409 otherwise
export function ApprovalsExpensesClient() {
    const t = useTranslations('portal.approvals.expenses');
    const tApprovals = useTranslations('portal.approvals');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [reports, setReports] = React.useState<ExpenseReport[]>([]);
    const [employees, setEmployees] = React.useState<TeamEmployee[]>([]);
    const [state, setState] = React.useState<LoadState>('loading');

    const [detailId, setDetailId] = React.useState<string | number | null>(null);
    const [detail, setDetail] = React.useState<ExpenseDetail | null>(null);
    const [detailState, setDetailState] = React.useState<LoadState>('loading');
    const [comment, setComment] = React.useState('');
    const [deciding, setDeciding] = React.useState<'approved' | 'rejected' | null>(null);

    const money = React.useCallback(
        (n: number, currency = 'MXN') => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n),
        [locale]
    );

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const [reps, emps] = await Promise.all([
                fetchJson('/api/proxy/expenses?status=submitted', expenseListResponseSchema),
                fetchJson('/api/proxy/employees', teamEmployeesResponseSchema)
                    .then(normalizeTeamEmployees)
                    .catch(() => [] as TeamEmployee[])
            ]);
            setReports(normalizeExpenseReports(reps));
            setEmployees(emps);
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const employeeName = (id: unknown) => {
        const e = employees.find((x) => String(x.id) === String(id ?? ''));
        return e ? employeeDisplayName(e) : `#${String(id ?? '?')}`;
    };

    const openDetail = React.useCallback(async (id: string | number) => {
        setDetailId(id);
        setDetail(null);
        setComment('');
        setDetailState('loading');
        try {
            const data = await fetchJson(`/api/proxy/expenses/${id}`, expenseDetailSchema);
            setDetail(data);
            setDetailState('done');
        } catch {
            setDetailState('error');
        }
    }, []);

    const decide = async (decision: 'approved' | 'rejected') => {
        if (detailId === null) return;
        setDeciding(decision);
        try {
            const { res, data } = await sendJson(`/api/proxy/expenses/${detailId}/decide`, {
                method: 'POST',
                body: { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) }
            });
            if (res.ok) {
                toast.success(decision === 'approved' ? t('approveOk') : t('rejectOk'));
                setDetailId(null);
                load();
                return;
            }
            if (res.status === 409) {
                toast.error(errorMessage(data) ?? t('errors.alreadyDecided'));
                setDetailId(null);
                load();
                return;
            }
            toast.error(errorMessage(data) ?? t('errors.generic'));
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
                        <Skeleton key={i} className="h-20 rounded-lg" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : reports.length === 0 ? (
                <EmptyState icon={<Receipt />} title={t('empty')} description={t('emptyHint')} />
            ) : (
                <ul className="flex flex-col gap-2">
                    {reports.map((r) => (
                        <li
                            key={String(r.id)}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{reportTitle(r)}</p>
                                <p className="text-xs text-muted-foreground">
                                    {employeeName((r as { employeeId?: unknown }).employeeId)}
                                    {reportDate(r) ? ` · ${formatDate(reportDate(r), locale)}` : ''}
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="font-display text-sm font-semibold">
                                    {money(expenseReportDisplayTotal(r), r.currency)}
                                </span>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => openDetail(r.id)}
                                    aria-label={t('reviewFor', { name: reportTitle(r) })}
                                >
                                    {t('review')}
                                </Button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" closeLabel={tCommon('close')}>
                    <DialogHeader>
                        <DialogTitle>
                            {detail?.title || reportTitle({ id: detailId ?? '' } as ExpenseReport)}
                        </DialogTitle>
                    </DialogHeader>

                    {detailState === 'loading' ? (
                        <div aria-busy="true" className="flex flex-col gap-2">
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-10 rounded-lg" />
                            ))}
                        </div>
                    ) : detailState === 'error' || !detail ? (
                        <EmptyState
                            icon={<SearchX />}
                            title={t('detailError')}
                            actionLabel={tCommon('retry')}
                            onAction={() => detailId !== null && openDetail(detailId)}
                        />
                    ) : (
                        <div className="flex flex-col gap-4">
                            <p className="text-xs text-muted-foreground">
                                {employeeName(detail.employeeId)}
                                {detail.submittedAt ? ` · ${formatDate(detail.submittedAt, locale)}` : ''}
                            </p>

                            {detail.items.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{t('noItems')}</p>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('itemDate')}</TableHead>
                                            <TableHead>{t('itemCategory')}</TableHead>
                                            <TableHead>{t('itemDescription')}</TableHead>
                                            <TableHead className="text-right">{t('itemAmount')}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {detail.items.map((item, i) => (
                                            <TableRow key={String(item.id ?? i)}>
                                                <TableCell className="whitespace-nowrap">
                                                    {formatDate(item.date, locale)}
                                                </TableCell>
                                                <TableCell>{item.category}</TableCell>
                                                <TableCell className="max-w-48 truncate">
                                                    {item.description || '—'}
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums">
                                                    {money(item.amount, detail.currency)}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}

                            <p className="text-right font-display text-lg font-semibold">
                                {t('total', { total: money(detail.total ?? 0, detail.currency) })}
                            </p>

                            <Textarea
                                rows={2}
                                maxLength={2000}
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                                placeholder={t('commentPlaceholder')}
                                aria-label={tApprovals('comment')}
                            />

                            <DialogFooter>
                                <Button
                                    variant="danger"
                                    loading={deciding === 'rejected'}
                                    disabled={deciding !== null}
                                    onClick={() => decide('rejected')}
                                >
                                    <X aria-hidden="true" />
                                    {t('reject')}
                                </Button>
                                <Button
                                    loading={deciding === 'approved'}
                                    disabled={deciding !== null}
                                    onClick={() => decide('approved')}
                                >
                                    <Check aria-hidden="true" />
                                    {t('approve')}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
