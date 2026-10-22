import { Router } from 'express';
import { z } from 'zod';
import { httpError } from '@strafor/node-common';
import { requireHR, type GatewayUser } from '../auth.js';
import type { TimeDeps } from '../deps.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const createScheduleSchema = z.object({
    name: z.string().min(1).max(120),
    type: z.enum(['fixed', 'flexible', 'shift']),
    weeklyHours: z.coerce.number().positive().max(84),
    config: z.record(z.string(), z.unknown()).default({})
});

const updateScheduleSchema = z
    .object({
        name: z.string().min(1).max(120),
        type: z.enum(['fixed', 'flexible', 'shift']),
        weeklyHours: z.coerce.number().positive().max(84),
        config: z.record(z.string(), z.unknown()),
        active: z.boolean()
    })
    .partial();

const assignSchema = z.object({
    employeeId: z.coerce.number().int().positive(),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.optional()
});

const unassignSchema = z.object({
    employeeId: z.coerce.number().int().positive(),
    effectiveTo: isoDate.optional()
});

function rowToSchedule(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        name: row.name,
        type: row.type,
        weeklyHours: Number(row.weekly_hours),
        config: row.config,
        active: row.active,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function rowToAssignment(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        employeeId: row.employee_id,
        scheduleId: Number(row.schedule_id),
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        createdAt: row.created_at
    };
}

function parseId(raw: string | undefined): number {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid schedule id');
    return id;
}

export function schedulesRouter(deps: TimeDeps): Router {
    const { pool, log } = deps;
    const router = Router();

    // All schedule management is HR-only (governance: admin → 403 via requireHR).

    // POST /v1/schedules — create a schedule template.
    router.post('/', requireHR, async (req, res, next) => {
        try {
            const parsed = createScheduleSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid schedule', parsed.error.issues);
            const b = parsed.data;
            const { rows } = await pool.query(
                `INSERT INTO work_schedules (name, type, weekly_hours, config)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [b.name, b.type, b.weeklyHours, JSON.stringify(b.config)]
            );
            res.status(201).json(rowToSchedule(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/schedules — list (?active=true|false to filter).
    router.get('/', requireHR, async (req, res, next) => {
        try {
            const active = req.query.active === 'true' ? true : req.query.active === 'false' ? false : null;
            const { rows } = await pool.query(
                `SELECT * FROM work_schedules
                 WHERE ($1::boolean IS NULL OR active = $1)
                 ORDER BY id`,
                [active]
            );
            res.json({ schedules: rows.map(rowToSchedule) });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/schedules/:id — one schedule plus its assignments.
    router.get('/:id', requireHR, async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const { rows } = await pool.query(`SELECT * FROM work_schedules WHERE id = $1`, [id]);
            if (!rows[0]) throw httpError(404, 'Schedule not found');
            const assignments = await pool.query(
                `SELECT * FROM employee_schedules WHERE schedule_id = $1 ORDER BY effective_from DESC`,
                [id]
            );
            res.json({
                ...rowToSchedule(rows[0]),
                assignments: assignments.rows.map(rowToAssignment)
            });
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/schedules/:id — partial update.
    router.put('/:id', requireHR, async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = updateScheduleSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid schedule update', parsed.error.issues);
            const b = parsed.data;
            if (Object.keys(b).length === 0) throw httpError(400, 'No fields to update');
            const { rows } = await pool.query(
                `UPDATE work_schedules SET
                    name = COALESCE($2, name),
                    type = COALESCE($3, type),
                    weekly_hours = COALESCE($4, weekly_hours),
                    config = COALESCE($5, config),
                    active = COALESCE($6, active),
                    updated_at = now()
                 WHERE id = $1 RETURNING *`,
                [
                    id,
                    b.name ?? null,
                    b.type ?? null,
                    b.weeklyHours ?? null,
                    b.config !== undefined ? JSON.stringify(b.config) : null,
                    b.active ?? null
                ]
            );
            if (!rows[0]) throw httpError(404, 'Schedule not found');
            res.json(rowToSchedule(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    // DELETE /v1/schedules/:id — soft-delete (active=false); assignments keep
    // their history rows.
    router.delete('/:id', requireHR, async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const { rows } = await pool.query(
                `UPDATE work_schedules SET active = false, updated_at = now()
                 WHERE id = $1 RETURNING *`,
                [id]
            );
            if (!rows[0]) throw httpError(404, 'Schedule not found');
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/schedules/:id/assign — assign an employee (hr-core integer id).
    // One open-ended assignment per employee is enforced by a partial unique
    // index — overlapping open assignments are a 409.
    router.post('/:id/assign', requireHR, async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = assignSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid assignment', parsed.error.issues);
            const b = parsed.data;
            const user = req.user as GatewayUser;

            const sched = await pool.query(`SELECT * FROM work_schedules WHERE id = $1`, [id]);
            if (!sched.rows[0]) throw httpError(404, 'Schedule not found');
            if (sched.rows[0].active !== true) throw httpError(409, 'Schedule is inactive');

            try {
                const { rows } = await pool.query(
                    `INSERT INTO employee_schedules (employee_id, schedule_id, effective_from, effective_to)
                     VALUES ($1, $2, $3, $4) RETURNING *`,
                    [b.employeeId, id, b.effectiveFrom, b.effectiveTo ?? null]
                );
                log.info({ employeeId: b.employeeId, scheduleId: id, by: user.userId }, 'schedule assigned');
                res.status(201).json(rowToAssignment(rows[0]));
            } catch (err) {
                if ((err as { code?: string }).code === '23505') {
                    throw httpError(
                        409,
                        'Employee already has an open schedule assignment — unassign first or set effectiveTo'
                    );
                }
                throw err;
            }
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/schedules/:id/unassign — close the employee's open assignment.
    router.post('/:id/unassign', requireHR, async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = unassignSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid unassign payload', parsed.error.issues);
            const b = parsed.data;

            const { rows } = await pool.query(
                `UPDATE employee_schedules
                 SET effective_to = COALESCE($3::date, CURRENT_DATE)
                 WHERE employee_id = $1 AND schedule_id = $2 AND effective_to IS NULL
                 RETURNING *`,
                [b.employeeId, id, b.effectiveTo ?? null]
            );
            if (!rows[0]) throw httpError(404, 'No open assignment for this employee/schedule');
            res.json(rowToAssignment(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    return router;
}
