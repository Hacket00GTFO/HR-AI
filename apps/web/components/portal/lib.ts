import { z } from 'zod';
import type {
    Asset,
    ExpenseItem,
    ExpenseReport,
    LeaveRequest,
    Ticket,
    assetListResponseSchema,
    expenseListResponseSchema,
    ticketListResponseSchema
} from './schemas';

// ── Pure helpers for the employee/candidate portal ──────────────────────────
// Kept free of React/fetch so they are unit-testable in isolation (see
// tests/portal-*.test.ts).

/** Round to cents — money math in MXN, avoids fp drift in totals. */
export function roundMoney(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Line-item total for one expense row (amount is already a per-row total). */
export function expenseItemTotal(item: Pick<ExpenseItem, 'amount'>): number {
    const n = Number(item.amount);
    return Number.isFinite(n) ? roundMoney(n) : 0;
}

/** Sum of all line items, rounded to cents. */
export function expenseReportTotal(items: Pick<ExpenseItem, 'amount'>[]): number {
    return roundMoney(items.reduce((acc, i) => acc + expenseItemTotal(i), 0));
}

/** Effective total for a stored report — server total wins, else item sum. */
export function expenseReportDisplayTotal(report: ExpenseReport): number {
    if (report.total != null && Number.isFinite(report.total)) return roundMoney(report.total);
    return expenseReportTotal(report.items);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDay(s: string): number | null {
    if (!ISO_DATE.test(s)) return null;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
}

/** Inclusive calendar-day span between two YYYY-MM-DD dates; null when invalid order/format. */
export function leaveDaysBetween(startDate: string, endDate: string): number | null {
    const start = parseIsoDay(startDate);
    const end = parseIsoDay(endDate);
    if (start === null || end === null) return null;
    const days = Math.round((end - start) / 86_400_000) + 1;
    return days > 0 ? days : null;
}

/**
 * Client-side leave-request validation — mirrors the upstream
 * POST /v1/leave/requests contract (leaveTypeId or leaveTypeCode required,
 * dates YYYY-MM-DD, endDate >= startDate, reason <= 2000 chars).
 * Messages are i18n keys resolved by the caller.
 */
export const leaveRequestInputSchema = z
    .object({
        leaveTypeId: z.coerce.number().int().positive(),
        startDate: z.string().regex(ISO_DATE, 'invalidDate'),
        endDate: z.string().regex(ISO_DATE, 'invalidDate'),
        reason: z.string().trim().max(2000, 'reasonTooLong').optional().default('')
    })
    .refine((v) => leaveDaysBetween(v.startDate, v.endDate) !== null, {
        path: ['endDate'],
        message: 'endBeforeStart'
    });
export type LeaveRequestInput = z.infer<typeof leaveRequestInputSchema>;

// ── list/record normalizers for the not-yet-stable upstream shapes ──────────

// `.loose()` index signatures defeat `in`-narrowing, so pick keys explicitly.
export function normalizeTickets(data: z.infer<typeof ticketListResponseSchema>): Ticket[] {
    if (Array.isArray(data)) return data;
    return (data as { tickets?: Ticket[]; data?: Ticket[] }).tickets ?? (data as { data: Ticket[] }).data;
}

export function normalizeExpenseReports(data: z.infer<typeof expenseListResponseSchema>): ExpenseReport[] {
    if (Array.isArray(data)) return data;
    const d = data as { reports?: ExpenseReport[]; expenses?: ExpenseReport[]; data?: ExpenseReport[] };
    return d.reports ?? d.expenses ?? (d.data as ExpenseReport[]);
}

export function normalizeAssets(data: z.infer<typeof assetListResponseSchema>): Asset[] {
    if (Array.isArray(data)) return data;
    const d = data as { assets?: Asset[]; data?: Asset[] };
    return d.assets ?? (d.data as Asset[]);
}

export function ticketTitle(t: Ticket): string {
    return t.subject || t.title || `#${String(t.id)}`;
}

export function ticketCreatedAt(t: Ticket): string | null {
    return t.created_at ?? t.createdAt ?? null;
}

export function assetTag(a: Asset): string {
    return a.tag || a.asset_tag || String(a.id);
}

export function assetType(a: Asset): string {
    return a.type || a.asset_type || '';
}

export function assetSince(a: Asset): string | null {
    return a.assigned_since ?? a.assignedSince ?? a.assigned_at ?? null;
}

export function reportTitle(r: ExpenseReport): string {
    return r.title || r.name || `#${String(r.id)}`;
}

export function reportDate(r: ExpenseReport): string | null {
    return r.submitted_at ?? r.submittedAt ?? r.created_at ?? r.createdAt ?? null;
}

/** True when the leave request can still be cancelled by its owner. */
export function isCancellable(r: LeaveRequest): boolean {
    return r.status === 'pending';
}

/** Today as YYYY-MM-DD (local). */
export function isoToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO-8601 bounds covering the current local day — for /attendance/mine?from&to. */
export function todayBounds(): { from: string; to: string } {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
}

/** Same-local-day check for an ISO timestamp. */
export function isToday(iso: string): boolean {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
