import { httpError } from '@strafor/node-common';

/**
 * Payroll period lifecycle — a strict state machine. Payroll is never
 * computed natively: periods move through calculation/review on imported
 * provider data, lock, export for disbursement, then reconcile (shadow mode)
 * before finalization.
 *
 *   draft → calculating → review → locked → exported → reconciled → finalized
 *   draft → cancelled          (only from draft)
 *   review → cancelled         (and review)
 *
 * Four-eyes guard: `locked→exported` and `reconciled→finalized` are money-
 * moving steps — the approver must differ from the period's created_by.
 */
export const PERIOD_STATUSES = [
    'draft',
    'calculating',
    'review',
    'locked',
    'exported',
    'reconciled',
    'finalized',
    'cancelled'
] as const;

export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

const TRANSITIONS: Record<PeriodStatus, readonly PeriodStatus[]> = {
    draft: ['calculating', 'cancelled'],
    calculating: ['review'],
    review: ['locked', 'cancelled'],
    locked: ['exported'],
    exported: ['reconciled'],
    reconciled: ['finalized'],
    finalized: [],
    cancelled: []
};

/** Transitions that require a different user than the period creator. */
const FOUR_EYES: ReadonlySet<string> = new Set(['locked->exported', 'reconciled->finalized']);

export function isPeriodStatus(v: unknown): v is PeriodStatus {
    return typeof v === 'string' && (PERIOD_STATUSES as readonly string[]).includes(v);
}

export function canTransition(from: PeriodStatus, to: PeriodStatus): boolean {
    return TRANSITIONS[from].includes(to);
}

/**
 * Validate a requested transition. Throws 409 on an illegal move — callers
 * surface it directly to the client.
 */
export function assertTransition(from: PeriodStatus, to: PeriodStatus): void {
    if (from === to) {
        throw httpError(409, `Period is already '${to}'`);
    }
    if (!canTransition(from, to)) {
        throw httpError(409, `Illegal status transition: ${from} → ${to}`);
    }
}

/** True when this transition requires approver != creator (four-eyes). */
export function requiresFourEyes(from: PeriodStatus, to: PeriodStatus): boolean {
    return FOUR_EYES.has(`${from}->${to}`);
}

/**
 * Enforce the four-eyes guard for money-moving transitions. The approver is
 * always the calling user — a pure service caller has no user identity and
 * can never satisfy "different user", so it is rejected (fail-closed).
 * Throws 409 when the approver is the period creator or identity is missing.
 */
export function assertFourEyes(
    from: PeriodStatus,
    to: PeriodStatus,
    createdBy: number | null,
    approverId: number | null
): void {
    if (!requiresFourEyes(from, to)) return;
    if (approverId === null) {
        throw httpError(409, `Transition ${from} → ${to} requires an approving user (four-eyes)`);
    }
    if (createdBy !== null && approverId === createdBy) {
        throw httpError(409, `Transition ${from} → ${to} requires a different approver than the period creator`);
    }
}
