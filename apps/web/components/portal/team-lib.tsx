import { z } from 'zod';
import type { LeaveBalance } from './schemas';

// ── Manager team-view wire schemas + pure helpers (/portal/team) ────────────
// Verified upstream contracts:
//   GET /v1/employees?managerId=<int>   hr-core — HR-ONLY today (requireHR);
//                                     filter allowlist key is `managerId`
//                                     (camelCase), not `manager_id`.
//   GET /v1/attendance/corrections?status=pending
//                                     time-attendance — hr/manager see all;
//                                     the "open anomalies" proxy.
//   GET /v1/leave/balances[?employeeId] time-attendance — hr sees all.
//   GET /api/auth/me                  BFF session info (id/role/name).
//
// NOTE (manager scoping): the gateway forwards X-Employee-Id but hr-core does
// not expose a "my reports" endpoint yet — employees?managerId= requires the
// hr role, so non-hr managers get 403 upstream and the client shows the
// error-retry state. Until hr-core wires user→employee we approximate the
// caller's employeeId with the session user id (upstream falls back the same
// way: employeeId := X-Employee-Id ?? userId).

const idSchema = z.union([z.number(), z.string()]);
const isoOrNull = z.string().nullable().optional().default(null);

// ── session user (GET /api/auth/me → { user }) ──────────────────────────────
export const sessionUserResponseSchema = z
    .object({
        user: z
            .object({
                id: idSchema.optional(),
                firstName: z.string().optional(),
                lastName: z.string().optional(),
                email: z.string().optional(),
                role: z.string().optional(),
                employeeId: idSchema.optional(),
                employee_id: idSchema.optional()
            })
            .loose()
            .nullable()
    })
    .loose();
export type SessionUserResponse = z.infer<typeof sessionUserResponseSchema>;

// ── employee directory row (hr-core rowToEmployee, camelCase; legacy
//    monolith emits snake_case — both tolerated) ────────────────────────────
export const teamEmployeeSchema = z
    .object({
        id: idSchema,
        firstName: z.string().optional(),
        first_name: z.string().optional(),
        lastName: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().nullable().optional().default(null),
        position: z.string().nullable().optional().default(null),
        department: z.string().nullable().optional().default(null),
        departmentId: idSchema.nullable().optional().default(null),
        department_id: idSchema.nullable().optional(),
        managerId: idSchema.nullable().optional().default(null),
        manager_id: idSchema.nullable().optional(),
        status: z.string().optional().default('active')
    })
    .loose();
export type TeamEmployee = z.infer<typeof teamEmployeeSchema>;

export const teamEmployeesResponseSchema = z.union([
    z.array(teamEmployeeSchema),
    z.object({ employees: z.array(teamEmployeeSchema) }).loose(),
    z.object({ data: z.array(teamEmployeeSchema) }).loose()
]);
export type TeamEmployeesResponse = z.infer<typeof teamEmployeesResponseSchema>;

// ── attendance corrections (time-attendance rowToCorrection) ────────────────
export const attendanceCorrectionSchema = z
    .object({
        id: idSchema,
        eventId: idSchema.optional(),
        employeeId: idSchema.optional(),
        field: z.string().optional().default(''),
        oldValue: z.unknown().optional(),
        newValue: z.unknown().optional(),
        reason: z.string().nullable().optional().default(null),
        status: z.string().optional().default('pending'),
        reviewedAt: isoOrNull,
        createdAt: isoOrNull
    })
    .loose();
export type AttendanceCorrection = z.infer<typeof attendanceCorrectionSchema>;

export const attendanceCorrectionsResponseSchema = z.union([
    z.object({ corrections: z.array(attendanceCorrectionSchema) }).loose(),
    z.array(attendanceCorrectionSchema)
]);
export type AttendanceCorrectionsResponse = z.infer<typeof attendanceCorrectionsResponseSchema>;

// ── pure helpers ────────────────────────────────────────────────────────────

const keyOf = (id: number | string | null | undefined): string => (id === null || id === undefined ? '' : String(id));

/** "First Last" across the camelCase/snake_case variants. */
export function employeeDisplayName(e: TeamEmployee): string {
    const name = [e.firstName ?? e.first_name, e.lastName ?? e.last_name].filter(Boolean).join(' ').trim();
    return name || `#${keyOf(e.id)}`;
}

/** Unwrap whichever employees envelope the upstream returned. */
export function normalizeTeamEmployees(data: TeamEmployeesResponse): TeamEmployee[] {
    if (Array.isArray(data)) return data;
    const d = data as { employees?: TeamEmployee[]; data?: TeamEmployee[] };
    return d.employees ?? d.data ?? [];
}

/** Unwrap corrections envelopes. */
export function normalizeCorrections(data: AttendanceCorrectionsResponse): AttendanceCorrection[] {
    if (Array.isArray(data)) return data;
    return (data as { corrections?: AttendanceCorrection[] }).corrections ?? [];
}

/** Caller employee id for ?managerId=: prefer explicit employeeId, else user id. */
export function callerEmployeeId(user: SessionUserResponse['user']): number | string | null {
    if (!user) return null;
    const raw = user.employeeId ?? user.employee_id ?? user.id;
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 'me';
}

/** Balances belonging to one employee (cross-schema employeeId compare). */
export function balancesFor(balances: LeaveBalance[], employeeId: number | string | null | undefined): LeaveBalance[] {
    const key = keyOf(employeeId);
    if (!key) return [];
    return balances.filter((b) => keyOf(b.employeeId) === key);
}

/** Open (pending) corrections filed for one employee. */
export function pendingCorrectionsFor(
    corrections: AttendanceCorrection[],
    employeeId: number | string | null | undefined
): AttendanceCorrection[] {
    const key = keyOf(employeeId);
    if (!key) return [];
    return corrections.filter((c) => keyOf(c.employeeId) === key && (c.status ?? 'pending') === 'pending');
}

/** Short "12d vacaciones · 5d permiso" balance summary parts for one member. */
export function balanceSummaryParts(
    balances: LeaveBalance[],
    typeName: (leaveTypeId: number) => string
): { label: string; available: number }[] {
    return balances.map((b) => ({ label: typeName(b.leaveTypeId), available: b.available }));
}
