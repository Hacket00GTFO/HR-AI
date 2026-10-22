/**
 * MX statutory vacation entitlement — Ley Federal del Trabajo art. 76
 * (reforma "vacaciones dignas", effective 2023-01-01):
 *
 *   completed years of service → paid vacation days
 *     1 → 12, 2 → 14, 3 → 16, 4 → 18, 5 → 20,
 *     then +2 days per additional 5-year block:
 *     6-10 → 22, 11-15 → 24, 16-20 → 26, 21-25 → 28, 26-30 → 30, 31-35 → 32.
 *
 * The same table is seeded into leave_types.accrual for the 'vacaciones'
 * code by migration 0001; keep both copies in sync.
 */
export interface AccrualStep {
    minYears: number;
    maxYears: number;
    days: number;
}

export const MX_VACATION_TABLE: readonly AccrualStep[] = [
    { minYears: 1, maxYears: 1, days: 12 },
    { minYears: 2, maxYears: 2, days: 14 },
    { minYears: 3, maxYears: 3, days: 16 },
    { minYears: 4, maxYears: 4, days: 18 },
    { minYears: 5, maxYears: 5, days: 20 },
    { minYears: 6, maxYears: 10, days: 22 },
    { minYears: 11, maxYears: 15, days: 24 },
    { minYears: 16, maxYears: 20, days: 26 },
    { minYears: 21, maxYears: 25, days: 28 },
    { minYears: 26, maxYears: 30, days: 30 },
    { minYears: 31, maxYears: 35, days: 32 }
];

/**
 * Completed (whole) years of service at `asOf`. The entitlement vests on the
 * work anniversary, so partial years do not count.
 */
export function yearsOfServiceAt(hireDate: Date, asOf: Date): number {
    let years = asOf.getUTCFullYear() - hireDate.getUTCFullYear();
    const anniversary = new Date(Date.UTC(asOf.getUTCFullYear(), hireDate.getUTCMonth(), hireDate.getUTCDate()));
    if (asOf.getTime() < anniversary.getTime()) years -= 1;
    return Math.max(0, years);
}

/** Statutory vacation days for `years` completed years of service (MX LFT-76). */
export function mxVacationDays(years: number): number {
    if (years < 1) return 0;
    const step = MX_VACATION_TABLE.find((s) => years >= s.minYears && years <= s.maxYears);
    if (step) return step.days;
    // Beyond the seeded table (36+ years) keep extending +2 per 5-year block.
    const last = MX_VACATION_TABLE[MX_VACATION_TABLE.length - 1] as AccrualStep;
    return last.days + Math.floor((years - last.maxYears - 1) / 5) * 2 + 2;
}

/** Parse an ISO YYYY-MM-DD date into a UTC Date; null when malformed. */
export function parseIsoDate(raw: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
    return d;
}
