import { Router } from 'express';
import { z } from 'zod';
import { httpError } from '@strafor/node-common';
import type { TimeDeps } from '../deps.js';
import { requireServiceToken } from '../auth.js';
import { withTransaction } from '../db.js';

/**
 * Internal-only routes — reachable exclusively with X-Service-Token, never
 * with user identity headers (users get 403, anonymous 401 via
 * requireServiceToken).
 *
 * DSAR fan-out endpoints called by apps/api utils/dsar.js. This service keys
 * everything by `employee_id` (hr-core employee id — a plain INTEGER, no
 * cross-db FK). The email→employee resolution happens upstream: the caller
 * passes `employeeId` once hr-core has resolved the subject; a bare numeric
 * subjectKey is also accepted as an employee id. When only an email/userId
 * is known and no employeeId was resolved, the endpoints report
 * `employee_unresolved` instead of guessing — employee_id and user_id are
 * different domains and conflating them would erase the wrong subject.
 */

const dsarRequestSchema = z
    .object({
        subjectKey: z.string().min(1).max(320),
        requestId: z.union([z.string().min(1).max(128), z.number().int().positive()]),
        email: z.string().email().max(255).optional(),
        userId: z.number().int().positive().optional(),
        employeeId: z.number().int().positive().optional()
    })
    .strict();

function resolveEmployeeId(d: z.infer<typeof dsarRequestSchema>): number | null {
    if (d.employeeId != null) return d.employeeId;
    if (/^\d+$/.test(d.subjectKey)) return Number(d.subjectKey);
    return null;
}

export function internalRouter(deps: TimeDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    router.use(requireServiceToken(config.SERVICE_AUTH_TOKEN));

    // POST /v1/internal/dsar-export — attendance, corrections, leave and
    // schedule data held for the subject's employee_id.
    router.post('/dsar-export', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const employeeId = resolveEmployeeId(parsed.data);
            if (employeeId == null) {
                res.json({ found: false, reason: 'employee_unresolved' });
                return;
            }

            const { rows: events } = await pool.query(
                `SELECT * FROM attendance_events WHERE employee_id = $1 ORDER BY occurred_at`,
                [employeeId]
            );
            const { rows: corrections } = await pool.query(
                `SELECT * FROM attendance_corrections WHERE employee_id = $1 ORDER BY created_at`,
                [employeeId]
            );
            const { rows: leave } = await pool.query(
                `SELECT lr.*, lt.code AS leave_type_code, lt.name AS leave_type_name
                   FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
                  WHERE lr.employee_id = $1 ORDER BY lr.created_at`,
                [employeeId]
            );
            const { rows: balances } = await pool.query(
                `SELECT lb.*, lt.code AS leave_type_code
                   FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
                  WHERE lb.employee_id = $1 ORDER BY lb.year`,
                [employeeId]
            );
            const { rows: schedules } = await pool.query(
                `SELECT * FROM employee_schedules WHERE employee_id = $1 ORDER BY effective_from`,
                [employeeId]
            );

            res.json({
                found: events.length + corrections.length + leave.length + balances.length + schedules.length > 0,
                employee_id: employeeId,
                attendance_events: events,
                attendance_corrections: corrections,
                leave_requests: leave,
                leave_balances: balances,
                employee_schedules: schedules
            });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/internal/dsar-erase — delete every row keyed by the subject's
    // employee_id. Deletion (not pseudonymisation) is correct here: the
    // employee_id is the ONLY personal identifier on these rows, so once the
    // rows are gone nothing identifies the subject. Idempotent — deleting an
    // already-empty set returns erased:true with zero counts.
    router.post('/dsar-erase', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const employeeId = resolveEmployeeId(parsed.data);
            if (employeeId == null) {
                res.json({ erased: false, detail: { reason: 'employee_unresolved' } });
                return;
            }

            const detail = await withTransaction(pool, async (client) => {
                const { rowCount: corr } = await client.query(
                    'DELETE FROM attendance_corrections WHERE employee_id = $1',
                    [employeeId]
                );
                const { rowCount: events } = await client.query(
                    'DELETE FROM attendance_events WHERE employee_id = $1',
                    [employeeId]
                );
                const { rowCount: leave } = await client.query('DELETE FROM leave_requests WHERE employee_id = $1', [
                    employeeId
                ]);
                const { rowCount: balances } = await client.query('DELETE FROM leave_balances WHERE employee_id = $1', [
                    employeeId
                ]);
                const { rowCount: schedules } = await client.query(
                    'DELETE FROM employee_schedules WHERE employee_id = $1',
                    [employeeId]
                );
                return {
                    employeeId,
                    attendanceCorrections: corr ?? 0,
                    attendanceEvents: events ?? 0,
                    leaveRequests: leave ?? 0,
                    leaveBalances: balances ?? 0,
                    employeeSchedules: schedules ?? 0
                };
            });

            res.json({ erased: true, detail });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
