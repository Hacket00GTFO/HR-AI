import { describe, it, expect } from 'vitest';
import {
    expenseItemTotal,
    expenseReportDisplayTotal,
    expenseReportTotal,
    isCancellable,
    leaveDaysBetween,
    leaveRequestInputSchema,
    roundMoney
} from '@/components/portal/lib';
import type { ExpenseReport, LeaveRequest } from '@/components/portal/schemas';

describe('expense totals', () => {
    it('computes a single item total', () => {
        expect(expenseItemTotal({ amount: 199.99 })).toBe(199.99);
    });

    it('sums line items and rounds to cents', () => {
        const items = [{ amount: 0.1 }, { amount: 0.2 }, { amount: 33.333 }];
        expect(expenseReportTotal(items)).toBe(33.63);
    });

    it('returns 0 for an empty item list', () => {
        expect(expenseReportTotal([])).toBe(0);
    });

    it('treats non-finite amounts as 0', () => {
        expect(expenseReportTotal([{ amount: Number.NaN }, { amount: 10 }])).toBe(10);
    });

    it('prefers the server-provided report total over the item sum', () => {
        const report = {
            id: 1,
            title: '',
            name: '',
            status: 'submitted',
            currency: 'MXN',
            total: 500,
            items: [{ amount: 1, date: '', category: '', description: '', currency: 'MXN' }]
        } as ExpenseReport;
        expect(expenseReportDisplayTotal(report)).toBe(500);
        expect(expenseReportDisplayTotal({ ...report, total: null })).toBe(1);
    });

    it('roundMoney avoids fp drift', () => {
        expect(roundMoney(1.005)).toBe(1.01);
        expect(roundMoney(-0)).toBe(0);
    });
});

describe('leave request validation', () => {
    const valid = { leaveTypeId: 1, startDate: '2026-03-10', endDate: '2026-03-12', reason: '' };

    it('accepts a valid request', () => {
        const r = leaveRequestInputSchema.safeParse(valid);
        expect(r.success).toBe(true);
    });

    it('rejects endDate before startDate', () => {
        const r = leaveRequestInputSchema.safeParse({ ...valid, endDate: '2026-03-09' });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message === 'endBeforeStart')).toBe(true);
        }
    });

    it('rejects malformed dates', () => {
        expect(leaveRequestInputSchema.safeParse({ ...valid, startDate: '10/03/2026' }).success).toBe(false);
        expect(leaveRequestInputSchema.safeParse({ ...valid, endDate: '' }).success).toBe(false);
    });

    it('rejects a missing leave type', () => {
        const r = leaveRequestInputSchema.safeParse({ ...valid, leaveTypeId: '' });
        expect(r.success).toBe(false);
    });

    it('rejects a reason longer than 2000 chars', () => {
        const r = leaveRequestInputSchema.safeParse({ ...valid, reason: 'x'.repeat(2001) });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message === 'reasonTooLong')).toBe(true);
        }
    });
});

describe('leaveDaysBetween', () => {
    it('counts inclusive calendar days', () => {
        expect(leaveDaysBetween('2026-03-10', '2026-03-10')).toBe(1);
        expect(leaveDaysBetween('2026-03-10', '2026-03-12')).toBe(3);
    });
    it('returns null when end precedes start or dates are invalid', () => {
        expect(leaveDaysBetween('2026-03-12', '2026-03-10')).toBeNull();
        expect(leaveDaysBetween('nope', '2026-03-10')).toBeNull();
    });
});

describe('isCancellable', () => {
    const base = {
        id: 1,
        leaveTypeId: 1,
        startDate: '2026-03-10',
        endDate: '2026-03-12',
        days: 3,
        status: 'pending',
        approverId: null,
        reason: null,
        decidedAt: null
    } as LeaveRequest;
    it('only pending requests are cancellable', () => {
        expect(isCancellable(base)).toBe(true);
        expect(isCancellable({ ...base, status: 'approved' })).toBe(false);
        expect(isCancellable({ ...base, status: 'rejected' })).toBe(false);
    });
});
