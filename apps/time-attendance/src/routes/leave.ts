import { Router } from 'express';
import { z } from 'zod';
import { httpError } from '@strafor/node-common';
import { LeaveDecided, LeaveRequested } from '../eventSchemas.js';
import { requireReviewer, requireServiceToken, requireUser, type GatewayUser } from '../auth.js';
import { withTransaction } from '../db.js';
import { mxVacationDays, parseIsoDate, yearsOfServiceAt } from '../mxVacation.js';
import type { TimeDeps } from '../deps.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const createRequestSchema = z
    .object({
        leaveTypeId: z.coerce.number().int().positive().optional(),
        leaveTypeCode: z.string().min(1).max(40).optional(),
        startDate: isoDate,
        endDate: isoDate,
        reason: z.string().max(2000).optional()
    })
    .refine((v) => v.leaveTypeId !== undefined || v.leaveTypeCode !== undefined, {
        message: 'leaveTypeId or leaveTypeCode is required'
    });

const accrueSchema = z.object({
    employeeId: z.coerce.number().int().positive(),
    hireDate: isoDate,
    asOf: isoDate.optional()
});

function rowToLeaveType(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        code: row.code,
        name: row.name,
        paid: row.paid,
        requiresApproval: row.requires_approval,
        accrual: row.accrual
    };
}

function rowToRequest(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        employeeId: row.employee_id,
        leaveTypeId: Number(row.leave_type_id),
        startDate: row.start_date,
        endDate: row.end_date,
        days: Number(row.days),
        status: row.status,
        approverId: row.approver_id,
        reason: row.reason,
        decidedAt: row.decided_at,
        createdAt: row.created_at
    };
}

function rowToBalance(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        employeeId: row.employee_id,
        leaveTypeId: Number(row.leave_type_id),
        year: row.year,
        entitled: Number(row.entitled),
        used: Number(row.used),
        carried: Number(row.carried),
        available: Number(row.entitled) + Number(row.carried) - Number(row.used)
    };
}

/** Inclusive calendar-day span between two YYYY-MM-DD dates (UTC-safe). */
function daysBetween(startDate: string, endDate: string): number {
    const start = parseIsoDate(startDate);
    const end = parseIsoDate(endDate);
    if (!start || !end) throw httpError(400, 'Invalid startDate/endDate');
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days <= 0) throw httpError(400, 'endDate must be on or after startDate');
    return days;
}

/** True when the leave type draws from an entitlement balance (accrual table). */
function isEntitlementBearing(leaveType: Record<string, unknown>): boolean {
    const accrual = leaveType.accrual as { table?: unknown[] } | null;
    return Array.isArray(accrual?.table) && accrual.table.length > 0;
}

export function leaveRouter(deps: TimeDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();

    // GET /v1/leave/types — catalog incl. MX statutory seeds.
    router.get('/types', requireUser, async (_req, res, next) => {
        try {
            const { rows } = await pool.query(`SELECT * FROM leave_types ORDER BY id`);
            res.json({ types: rows.map(rowToLeaveType) });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/leave/requests — self-service request. Types that do not
    // require approval are auto-approved immediately.
    router.post('/requests', requireUser, async (req, res, next) => {
        try {
            const parsed = createRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid leave request', parsed.error.issues);
            const body = parsed.data;
            const user = req.user as GatewayUser;

            const days = daysBetween(body.startDate, body.endDate);

            const typeResult = body.leaveTypeId
                ? await pool.query(`SELECT * FROM leave_types WHERE id = $1`, [body.leaveTypeId])
                : await pool.query(`SELECT * FROM leave_types WHERE code = $1`, [body.leaveTypeCode]);
            const leaveType = typeResult.rows[0];
            if (!leaveType) throw httpError(404, 'Leave type not found');

            const autoApprove = leaveType.requires_approval !== true;
            const status = autoApprove ? 'approved' : 'pending';

            const { rows } = await pool.query(
                `INSERT INTO leave_requests
                    (employee_id, leave_type_id, start_date, end_date, days, status, reason, decided_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 = 'approved' THEN now() ELSE NULL END)
                 RETURNING *`,
                [user.employeeId, leaveType.id, body.startDate, body.endDate, days, status, body.reason ?? null]
            );
            const created = rows[0];

            await publisher.publish(
                LeaveRequested,
                'strafor.leave.requested',
                {
                    requestId: Number(created.id),
                    employeeId: user.employeeId,
                    leaveType: String(leaveType.code),
                    startDate: body.startDate,
                    endDate: body.endDate,
                    days,
                    requiresApproval: !autoApprove
                },
                req.correlationId
            );
            if (autoApprove) {
                await publisher.publish(
                    LeaveDecided,
                    'strafor.leave.decided',
                    {
                        requestId: Number(created.id),
                        employeeId: user.employeeId,
                        leaveType: String(leaveType.code),
                        decision: 'approved'
                    },
                    req.correlationId
                );
            }

            res.status(201).json(rowToRequest(created));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/leave/requests — self sees own; hr sees all (+filters).
    router.get('/requests', requireUser, async (req, res, next) => {
        try {
            const user = req.user as GatewayUser;
            const q = z
                .object({
                    employeeId: z.coerce.number().int().positive().optional(),
                    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional()
                })
                .safeParse(req.query);
            if (!q.success) throw httpError(400, 'Invalid query', q.error.issues);

            const employeeFilter = user.role === 'hr' ? (q.data.employeeId ?? null) : user.employeeId;
            const { rows } = await pool.query(
                `SELECT * FROM leave_requests
                 WHERE ($1::int IS NULL OR employee_id = $1)
                   AND ($2::text IS NULL OR status = $2)
                 ORDER BY created_at DESC
                 LIMIT 500`,
                [employeeFilter, q.data.status ?? null]
            );
            res.json({ requests: rows.map(rowToRequest) });
        } catch (err) {
            next(err);
        }
    });

    const decideRequest =
        (decision: 'approved' | 'rejected') =>
        async (
            req: import('express').Request,
            res: import('express').Response,
            next: import('express').NextFunction
        ) => {
            try {
                const id = Number(req.params.id);
                if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid request id');
                const user = req.user as GatewayUser;

                const { updated, leaveTypeCode } = await withTransaction(pool, async (client) => {
                    const { rows } = await client.query(`SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE`, [id]);
                    const request = rows[0];
                    if (!request) throw httpError(404, 'Leave request not found');
                    if (request.status !== 'pending') {
                        throw httpError(409, `Leave request already ${request.status}`);
                    }

                    const typeRes = await client.query(`SELECT * FROM leave_types WHERE id = $1`, [
                        request.leave_type_id
                    ]);
                    const leaveType = typeRes.rows[0];

                    if (decision === 'approved' && leaveType && isEntitlementBearing(leaveType)) {
                        // Entitlement-bearing type (e.g. vacaciones): the balance
                        // must cover the request — checked and decremented in tx.
                        const year = new Date(request.start_date).getUTCFullYear();
                        const bal = await client.query(
                            `SELECT * FROM leave_balances
                             WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3
                             FOR UPDATE`,
                            [request.employee_id, request.leave_type_id, year]
                        );
                        const balance = bal.rows[0];
                        const available = balance
                            ? Number(balance.entitled) + Number(balance.carried) - Number(balance.used)
                            : 0;
                        if (available < Number(request.days)) {
                            throw httpError(409, 'Insufficient leave balance', {
                                available,
                                requested: Number(request.days)
                            });
                        }
                        await client.query(
                            `UPDATE leave_balances
                             SET used = used + $4, updated_at = now()
                             WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
                            [request.employee_id, request.leave_type_id, year, request.days]
                        );
                    }

                    const upd = await client.query(
                        `UPDATE leave_requests
                         SET status = $2, approver_id = $3, decided_at = now()
                         WHERE id = $1 RETURNING *`,
                        [id, decision, user.userId]
                    );
                    return { updated: upd.rows[0], leaveTypeCode: String(leaveType?.code ?? 'unknown') };
                });

                await publisher.publish(
                    LeaveDecided,
                    'strafor.leave.decided',
                    {
                        requestId: id,
                        employeeId: updated.employee_id,
                        leaveType: leaveTypeCode,
                        decision,
                        approverId: user.userId
                    },
                    req.correlationId
                );
                log.info({ requestId: id, decision, approver: user.userId }, 'leave request decided');
                res.json(rowToRequest(updated));
            } catch (err) {
                next(err);
            }
        };

    // PUT /v1/leave/requests/:id/approve|reject — hr or manager.
    router.put('/requests/:id/approve', requireReviewer, decideRequest('approved'));
    router.put('/requests/:id/reject', requireReviewer, decideRequest('rejected'));

    // PUT /v1/leave/requests/:id/cancel — owner cancels a pending request.
    router.put('/requests/:id/cancel', requireUser, async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid request id');
            const user = req.user as GatewayUser;

            const { rows } = await pool.query(`SELECT * FROM leave_requests WHERE id = $1`, [id]);
            const request = rows[0];
            if (!request) throw httpError(404, 'Leave request not found');
            if (request.employee_id !== user.employeeId && user.role !== 'hr') {
                throw httpError(403, 'Forbidden');
            }
            if (request.status !== 'pending') {
                throw httpError(409, `Leave request already ${request.status}`);
            }
            const upd = await pool.query(
                `UPDATE leave_requests SET status = 'cancelled', decided_at = now()
                 WHERE id = $1 RETURNING *`,
                [id]
            );
            res.json(rowToRequest(upd.rows[0]));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/leave/balances — self sees own; hr sees all or ?employeeId=.
    router.get('/balances', requireUser, async (req, res, next) => {
        try {
            const user = req.user as GatewayUser;
            const q = z
                .object({
                    employeeId: z.coerce.number().int().positive().optional(),
                    year: z.coerce.number().int().min(2000).max(2200).optional()
                })
                .safeParse(req.query);
            if (!q.success) throw httpError(400, 'Invalid query', q.error.issues);

            const employeeFilter = user.role === 'hr' ? (q.data.employeeId ?? null) : user.employeeId;
            const { rows } = await pool.query(
                `SELECT * FROM leave_balances
                 WHERE ($1::int IS NULL OR employee_id = $1)
                   AND ($2::int IS NULL OR year = $2)
                 ORDER BY employee_id, year, leave_type_id`,
                [employeeFilter, q.data.year ?? null]
            );
            res.json({ balances: rows.map(rowToBalance) });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/leave/accrue — internal (service-token): recompute the MX
    // statutory vacation entitlement from hire_date and upsert the
    // (employee, vacaciones, year) balance row. Idempotent.
    router.post('/accrue', requireServiceToken(config.SERVICE_AUTH_TOKEN), async (req, res, next) => {
        try {
            const parsed = accrueSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid accrual payload', parsed.error.issues);
            const { employeeId, hireDate, asOf } = parsed.data;

            const hire = parseIsoDate(hireDate);
            const asOfDate = asOf ? parseIsoDate(asOf) : new Date();
            if (!hire || !asOfDate) throw httpError(400, 'Invalid hireDate/asOf');

            const years = yearsOfServiceAt(hire, asOfDate);
            const entitled = mxVacationDays(years);
            const year = asOfDate.getUTCFullYear();

            const typeRes = await pool.query(`SELECT * FROM leave_types WHERE code = 'vacaciones'`);
            const vacType = typeRes.rows[0];
            if (!vacType) throw httpError(500, 'leave_types seed missing: vacaciones');

            const { rows } = await pool.query(
                `INSERT INTO leave_balances (employee_id, leave_type_id, year, entitled)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (employee_id, leave_type_id, year)
                 DO UPDATE SET entitled = EXCLUDED.entitled, updated_at = now()
                 RETURNING *`,
                [employeeId, vacType.id, year, entitled]
            );
            log.info({ employeeId, year, years, entitled }, 'vacation entitlement accrued');
            res.json({
                employeeId,
                leaveType: 'vacaciones',
                year,
                yearsOfService: years,
                entitled,
                balance: rowToBalance(rows[0])
            });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
