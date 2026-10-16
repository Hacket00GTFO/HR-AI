import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import { EmployeeTerminated, EmployeeUpdated } from '@strafor/contracts/events/hr.js';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction } from '../db.js';

export interface OnboardingDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const idParam = z.coerce.number().int().positive();
function parseId(raw: string | undefined, what = 'id'): number {
    const parsed = idParam.safeParse(raw);
    if (!parsed.success) throw httpError(400, `Invalid ${what}`);
    return parsed.data;
}

/**
 * Default interdepartmental checklists — used when POST /v1/onboarding does
 * not carry an explicit `tasks` list. `blocking` tasks gate case completion
 * (see completeCase below).
 */
const DEFAULT_TASKS: Record<'onboarding' | 'offboarding', Array<Record<string, unknown>>> = {
    onboarding: [
        { title: 'Sign employment contract', department: 'HR', blocking: true },
        { title: 'Collect tax/social-security documents (RFC, CURP, NSS)', department: 'HR', blocking: true },
        { title: 'Create identity account', department: 'IT', blocking: true },
        { title: 'Provision laptop and assets', department: 'IT', blocking: false },
        { title: 'Payroll enrollment', department: 'Finance', blocking: true },
        { title: 'Orientation / assign buddy', department: 'HR', blocking: false }
    ],
    offboarding: [
        { title: 'Revoke system access', department: 'IT', blocking: true },
        { title: 'Collect equipment and assets', department: 'IT', blocking: true },
        { title: 'Final payroll settlement (finiquito)', department: 'Finance', blocking: true },
        { title: 'Exit interview', department: 'HR', blocking: false },
        { title: 'Archive employee documents', department: 'HR', blocking: false }
    ]
};

const taskInputSchema = z
    .object({
        title: z.string().min(1).max(300),
        department: z.string().max(100).optional(),
        ownerUserId: z.number().int().positive().optional(),
        dueDate: z.iso.date().optional(),
        blocking: z.boolean().default(false),
        notes: z.string().max(2000).optional()
    })
    .strict();

const createCaseSchema = z
    .object({
        employeeId: z.number().int().positive(),
        type: z.enum(['onboarding', 'offboarding']).default('onboarding'),
        dueDate: z.iso.date().optional(),
        tasks: z.array(taskInputSchema).max(100).optional()
    })
    .strict();

const updateCaseSchema = z
    .object({
        status: z.enum(['open', 'in_progress', 'blocked', 'completed', 'cancelled']).optional(),
        dueDate: z.iso.date().nullable().optional()
    })
    .strict();

const updateTaskSchema = z
    .object({
        status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional(),
        notes: z.string().max(2000).nullable().optional(),
        ownerUserId: z.number().int().positive().nullable().optional(),
        dueDate: z.iso.date().nullable().optional(),
        blocking: z.boolean().optional()
    })
    .strict();

const CASE_FILTER_ALLOWLIST = new Set(['type', 'status', 'employeeId']);
const CASE_COLUMNS: Record<string, string> = { type: 'type', status: 'status', employeeId: 'employee_id' };

const toDateStr = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
};

function rowToCase(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        employeeId: Number(row.employee_id),
        type: row.type,
        status: row.status,
        startedBy: row.started_by != null ? Number(row.started_by) : null,
        dueDate: toDateStr(row.due_date),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.employee_first_name !== undefined || row.employee_last_name !== undefined
            ? {
                  employee: {
                      firstName: row.employee_first_name ?? null,
                      lastName: row.employee_last_name ?? null,
                      employeeNumber: row.employee_number ?? null
                  }
              }
            : {})
    };
}

function rowToTask(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        caseId: Number(row.case_id),
        title: row.title,
        department: row.department ?? null,
        ownerUserId: row.owner_user_id != null ? Number(row.owner_user_id) : null,
        status: row.status,
        dueDate: toDateStr(row.due_date),
        completedAt: row.completed_at ?? null,
        blocking: row.blocking === true,
        notes: row.notes ?? null,
        createdAt: row.created_at
    };
}

interface CaseCounts {
    pendingAll: number;
    pendingBlocking: number;
    blockedCount: number;
}

async function taskCounts(client: PoolClient | Pool, caseId: number): Promise<CaseCounts> {
    const { rows } = await client.query(
        `SELECT count(*) FILTER (WHERE status <> 'done')::int           AS pending_all,
                count(*) FILTER (WHERE blocking AND status <> 'done')::int AS pending_blocking,
                count(*) FILTER (WHERE status = 'blocked')::int            AS blocked_count
         FROM onboarding_tasks WHERE case_id = $1`,
        [caseId]
    );
    const r = rows[0] ?? { pending_all: 0, pending_blocking: 0, blocked_count: 0 };
    return {
        pendingAll: Number(r.pending_all),
        pendingBlocking: Number(r.pending_blocking),
        blockedCount: Number(r.blocked_count)
    };
}

/**
 * Flip the employee record when a case completes:
 *   onboarding completed  → status 'active'
 *   offboarding completed → status 'terminated' + termination_date
 */
async function applyEmployeeTransition(
    client: PoolClient | Pool,
    caseType: string,
    employeeId: number
): Promise<Record<string, unknown> | null> {
    if (caseType === 'offboarding') {
        const { rows } = await client.query(
            `UPDATE employees
             SET status = 'terminated',
                 termination_date = COALESCE(termination_date, CURRENT_DATE),
                 updated_at = now()
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [employeeId]
        );
        return rows[0] ?? null;
    }
    const { rows } = await client.query(
        `UPDATE employees SET status = 'active', updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *`,
        [employeeId]
    );
    return rows[0] ?? null;
}

export function onboardingRouter(deps: OnboardingDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();

    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR);

    // POST /v1/onboarding — open a case; task list comes from the request
    // body or the built-in per-type template.
    router.post('/', async (req, res, next) => {
        try {
            const parsed = createCaseSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid onboarding payload', parsed.error.issues);
            const { employeeId, type, dueDate } = parsed.data;
            const tasks = parsed.data.tasks ?? DEFAULT_TASKS[type];
            const startedBy = req.user?.userId ?? null;

            const created = await withTransaction(pool, async (client) => {
                const { rows: emp } = await client.query(
                    `SELECT id FROM employees WHERE id = $1 AND deleted_at IS NULL`,
                    [employeeId]
                );
                if (!emp[0]) throw httpError(404, 'Employee not found');

                let caseRow;
                try {
                    ({
                        rows: [caseRow]
                    } = await client.query(
                        `INSERT INTO onboarding_cases (employee_id, type, status, started_by, due_date)
                         VALUES ($1, $2, 'open', $3, $4) RETURNING *`,
                        [employeeId, type, startedBy, dueDate ?? null]
                    ));
                } catch (err) {
                    if ((err as { code?: string }).code === '23505') {
                        throw httpError(409, `An open ${type} case already exists for this employee`);
                    }
                    throw err;
                }

                const taskRows = [];
                for (const t of tasks) {
                    const { rows } = await client.query(
                        `INSERT INTO onboarding_tasks (case_id, title, department, owner_user_id, due_date, blocking, notes)
                         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                        [
                            caseRow.id,
                            t.title,
                            t.department ?? null,
                            t.ownerUserId ?? null,
                            t.dueDate ?? null,
                            t.blocking ?? false,
                            t.notes ?? null
                        ]
                    );
                    taskRows.push(rows[0]);
                }
                return { caseRow, taskRows };
            });

            log.info({ caseId: created.caseRow.id, employeeId, type }, 'onboarding case opened');
            res.status(201).json({
                ...rowToCase(created.caseRow),
                tasks: created.taskRows.map(rowToTask)
            });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/onboarding — allowlisted filters (type, status, employeeId).
    router.get('/', async (req, res, next) => {
        try {
            const where: string[] = ['TRUE'];
            const params: unknown[] = [];
            for (const [key, value] of Object.entries(req.query)) {
                if (value == null || value === '' || Array.isArray(value)) continue;
                if (!CASE_FILTER_ALLOWLIST.has(key)) continue;
                const column = CASE_COLUMNS[key];
                if (!column) continue;
                params.push(value);
                where.push(`c.${column} = $${params.length}`);
            }
            const { rows } = await pool.query(
                `SELECT c.*, e.first_name AS employee_first_name, e.last_name AS employee_last_name,
                        e.employee_number
                 FROM onboarding_cases c
                 JOIN employees e ON e.id = c.employee_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY c.created_at DESC`,
                params
            );
            res.json(rows.map(rowToCase));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/onboarding/:id — case with its task list.
    router.get('/:id(\\d+)', async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'case id');
            const { rows } = await pool.query(
                `SELECT c.*, e.first_name AS employee_first_name, e.last_name AS employee_last_name,
                        e.employee_number
                 FROM onboarding_cases c
                 JOIN employees e ON e.id = c.employee_id
                 WHERE c.id = $1`,
                [id]
            );
            if (!rows[0]) throw httpError(404, 'Onboarding case not found');
            const { rows: tasks } = await pool.query(`SELECT * FROM onboarding_tasks WHERE case_id = $1 ORDER BY id`, [
                id
            ]);
            res.json({ ...rowToCase(rows[0]), tasks: tasks.map(rowToTask) });
        } catch (err) {
            next(err);
        }
    });

    /**
     * PUT /v1/onboarding/:id — manual case transitions.
     *   completed: onboarding requires ALL tasks done; offboarding requires
     *              all BLOCKING tasks done (non-blocking stragglers may
     *              remain). Blocking tasks pending → 409.
     *   cancelled: always allowed from a non-terminal state.
     */
    router.put('/:id(\\d+)', async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'case id');
            const parsed = updateCaseSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid case payload', parsed.error.issues);
            const { status, dueDate } = parsed.data;
            if (status === undefined && dueDate === undefined) {
                throw httpError(400, 'No fields to update');
            }

            const outcome = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM onboarding_cases WHERE id = $1 FOR UPDATE`, [id]);
                const caseRow = rows[0];
                if (!caseRow) throw httpError(404, 'Onboarding case not found');
                const terminal = ['completed', 'cancelled'].includes(caseRow.status);
                if (terminal) throw httpError(409, `Case is already ${caseRow.status}`);

                let employee: Record<string, unknown> | null = null;
                if (status === 'completed') {
                    const counts = await taskCounts(client, id);
                    if (caseRow.type === 'offboarding') {
                        if (counts.pendingBlocking > 0) {
                            throw httpError(409, 'Offboarding cannot complete while blocking tasks are pending');
                        }
                    } else if (counts.pendingAll > 0) {
                        throw httpError(409, 'Onboarding cannot complete while tasks are pending');
                    }
                    employee = await applyEmployeeTransition(client, caseRow.type, Number(caseRow.employee_id));
                }
                if (status !== undefined || dueDate !== undefined) {
                    await client.query(
                        `UPDATE onboarding_cases
                         SET status = COALESCE($2, status),
                             due_date = CASE WHEN $3::boolean THEN $4 ELSE due_date END,
                             updated_at = now()
                         WHERE id = $1`,
                        [id, status ?? null, dueDate !== undefined, dueDate ?? null]
                    );
                }
                const { rows: fresh } = await client.query(`SELECT * FROM onboarding_cases WHERE id = $1`, [id]);
                return { caseRow: fresh[0], employee, statusChangedTo: status };
            });

            if (outcome.statusChangedTo === 'completed' && outcome.employee) {
                const emp = outcome.employee;
                if (outcome.caseRow.type === 'offboarding') {
                    await publisher.publish(
                        EmployeeTerminated,
                        'strafor.hr.employee_terminated',
                        {
                            employeeId: Number(emp.id),
                            employeeNumber: emp.employee_number,
                            status: 'terminated',
                            terminationDate: toDateStr(emp.termination_date) ?? undefined,
                            reason: 'offboarding'
                        },
                        req.correlationId
                    );
                } else {
                    await publisher.publish(
                        EmployeeUpdated,
                        'strafor.hr.employee_updated',
                        {
                            employeeId: Number(emp.id),
                            employeeNumber: emp.employee_number,
                            changedFields: ['status'],
                            status: 'active'
                        },
                        req.correlationId
                    );
                }
            }

            const { rows: tasks } = await pool.query(`SELECT * FROM onboarding_tasks WHERE case_id = $1 ORDER BY id`, [
                id
            ]);
            res.json({ ...rowToCase(outcome.caseRow), tasks: tasks.map(rowToTask) });
        } catch (err) {
            next(err);
        }
    });

    /**
     * PUT /v1/onboarding/tasks/:taskId — task status transitions drive the
     * case rollup:
     *   all tasks done                      → case completed (+employee flip)
     *   offboarding, all blocking done      → case completed (+terminated)
     *   any task blocked                    → case 'blocked'
     *   otherwise                           → case 'in_progress'
     * Tasks of completed/cancelled cases are immutable → 409.
     */
    router.put('/tasks/:taskId', async (req, res, next) => {
        try {
            const taskId = parseId(req.params.taskId, 'task id');
            const parsed = updateTaskSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid task payload', parsed.error.issues);
            const data = parsed.data;
            if (Object.keys(data).length === 0) throw httpError(400, 'No fields to update');

            const outcome = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `SELECT t.*, c.type AS case_type, c.status AS case_status, c.employee_id
                     FROM onboarding_tasks t
                     JOIN onboarding_cases c ON c.id = t.case_id
                     WHERE t.id = $1
                     FOR UPDATE OF t`,
                    [taskId]
                );
                const task = rows[0];
                if (!task) throw httpError(404, 'Task not found');
                if (['completed', 'cancelled'].includes(task.case_status)) {
                    throw httpError(409, `Case is already ${task.case_status}`);
                }

                await client.query(
                    `UPDATE onboarding_tasks
                     SET status = COALESCE($2, status),
                         completed_at = CASE
                             WHEN $2 = 'done' THEN now()
                             WHEN $2 IS NOT NULL THEN NULL
                             ELSE completed_at END,
                         notes = CASE WHEN $3::boolean THEN $4 ELSE notes END,
                         owner_user_id = CASE WHEN $5::boolean THEN $6 ELSE owner_user_id END,
                         due_date = CASE WHEN $7::boolean THEN $8 ELSE due_date END,
                         blocking = COALESCE($9, blocking)
                     WHERE id = $1`,
                    [
                        taskId,
                        data.status ?? null,
                        data.notes !== undefined,
                        data.notes ?? null,
                        data.ownerUserId !== undefined,
                        data.ownerUserId ?? null,
                        data.dueDate !== undefined,
                        data.dueDate ?? null,
                        data.blocking ?? null
                    ]
                );

                const counts = await taskCounts(client, task.case_id);
                let newStatus: string;
                let completed = false;
                if (counts.pendingAll === 0) {
                    newStatus = 'completed';
                    completed = true;
                } else if (task.case_type === 'offboarding' && counts.pendingBlocking === 0) {
                    // Offboarding completes once every blocking task is done;
                    // non-blocking stragglers don't hold a termination.
                    newStatus = 'completed';
                    completed = true;
                } else if (counts.blockedCount > 0) {
                    newStatus = 'blocked';
                } else {
                    newStatus = 'in_progress';
                }

                let employee: Record<string, unknown> | null = null;
                if (completed) {
                    employee = await applyEmployeeTransition(client, task.case_type, Number(task.employee_id));
                }
                await client.query(`UPDATE onboarding_cases SET status = $2, updated_at = now() WHERE id = $1`, [
                    task.case_id,
                    newStatus
                ]);

                const { rows: taskRows } = await client.query(`SELECT * FROM onboarding_tasks WHERE id = $1`, [taskId]);
                const { rows: caseRows } = await client.query(`SELECT * FROM onboarding_cases WHERE id = $1`, [
                    task.case_id
                ]);
                return { task: taskRows[0], caseRow: caseRows[0], completed, employee };
            });

            if (outcome.completed && outcome.employee) {
                const emp = outcome.employee;
                if (outcome.caseRow.type === 'offboarding') {
                    await publisher.publish(
                        EmployeeTerminated,
                        'strafor.hr.employee_terminated',
                        {
                            employeeId: Number(emp.id),
                            employeeNumber: emp.employee_number,
                            status: 'terminated',
                            terminationDate: toDateStr(emp.termination_date) ?? undefined,
                            reason: 'offboarding'
                        },
                        req.correlationId
                    );
                } else {
                    await publisher.publish(
                        EmployeeUpdated,
                        'strafor.hr.employee_updated',
                        {
                            employeeId: Number(emp.id),
                            employeeNumber: emp.employee_number,
                            changedFields: ['status'],
                            status: 'active'
                        },
                        req.correlationId
                    );
                }
                log.info({ caseId: outcome.caseRow.id }, 'onboarding case completed');
            }

            res.json({ task: rowToTask(outcome.task), case: rowToCase(outcome.caseRow) });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
