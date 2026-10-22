// Lifecycle transition matrix — pure validator tests, no HTTP.
import { describe, expect, it } from 'vitest';
import {
    assertFourEyes,
    assertTransition,
    canTransition,
    isPeriodStatus,
    requiresFourEyes,
    type PeriodStatus
} from '../src/lifecycle.js';

const STATUSES: PeriodStatus[] = [
    'draft',
    'calculating',
    'review',
    'locked',
    'exported',
    'reconciled',
    'finalized',
    'cancelled'
];

const LEGAL: Array<[PeriodStatus, PeriodStatus]> = [
    ['draft', 'calculating'],
    ['draft', 'cancelled'],
    ['calculating', 'review'],
    ['review', 'locked'],
    ['review', 'cancelled'],
    ['locked', 'exported'],
    ['exported', 'reconciled'],
    ['reconciled', 'finalized']
];

describe('transition matrix', () => {
    it.each(LEGAL)('%s → %s is legal', (from, to) => {
        expect(canTransition(from, to)).toBe(true);
        expect(() => assertTransition(from, to)).not.toThrow();
    });

    // The full 8x8 matrix minus legal pairs must all throw 409.
    const illegal = STATUSES.flatMap((from) =>
        STATUSES.filter((to) => !LEGAL.some(([f, t]) => f === from && t === to)).map(
            (to) => [from, to] as [PeriodStatus, PeriodStatus]
        )
    );

    it.each(illegal)('%s → %s is rejected with 409', (from, to) => {
        expect(canTransition(from, to)).toBe(false);
        try {
            assertTransition(from, to);
            expect.unreachable('expected 409');
        } catch (err) {
            expect((err as { status?: number }).status).toBe(409);
        }
    });

    it('cancelled is only reachable from draft/review', () => {
        for (const from of STATUSES) {
            const ok = from === 'draft' || from === 'review';
            expect(canTransition(from, 'cancelled')).toBe(ok);
        }
    });

    it('finalized and cancelled are terminal', () => {
        for (const to of STATUSES) {
            expect(canTransition('finalized', to)).toBe(false);
            expect(canTransition('cancelled', to)).toBe(false);
        }
    });

    it('isPeriodStatus narrows valid statuses', () => {
        expect(isPeriodStatus('draft')).toBe(true);
        expect(isPeriodStatus('nonsense')).toBe(false);
        expect(isPeriodStatus(42)).toBe(false);
    });
});

describe('four-eyes guard', () => {
    it('locked→exported and reconciled→finalized require four-eyes', () => {
        expect(requiresFourEyes('locked', 'exported')).toBe(true);
        expect(requiresFourEyes('reconciled', 'finalized')).toBe(true);
        expect(requiresFourEyes('draft', 'calculating')).toBe(false);
        expect(requiresFourEyes('review', 'locked')).toBe(false);
    });

    it('same approver as creator → 409', () => {
        try {
            assertFourEyes('locked', 'exported', 2, 2);
            expect.unreachable('expected 409');
        } catch (err) {
            expect((err as { status?: number }).status).toBe(409);
        }
    });

    it('different approver passes', () => {
        expect(() => assertFourEyes('locked', 'exported', 2, 9)).not.toThrow();
        expect(() => assertFourEyes('reconciled', 'finalized', 2, 9)).not.toThrow();
    });

    it('missing approver identity (service caller) → 409', () => {
        try {
            assertFourEyes('locked', 'exported', 2, null);
            expect.unreachable('expected 409');
        } catch (err) {
            expect((err as { status?: number }).status).toBe(409);
        }
    });

    it('non-four-eyes transitions skip the check entirely', () => {
        expect(() => assertFourEyes('draft', 'calculating', 2, 2)).not.toThrow();
        expect(() => assertFourEyes('draft', 'calculating', 2, null)).not.toThrow();
    });
});
