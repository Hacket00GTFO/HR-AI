import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import { enqueueEvent, flushOutbox, type EventPublisher } from '../events.js';
import { requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction } from '../db.js';

export interface WorkflowsDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const DEPARTMENTS = ['it', 'hr', 'finance', 'facilities', 'legal', 'other'] as const;
const WORKFLOW_KINDS = ['onboarding', 'offboarding'] as const;
const WORKFLOW_STATUSES = ['active', 'completed', 'cancelled'] as const;

const idParam = z.coerce.number().int().positive();
function parseId(raw: string | undefined, what = 'id'): number {
    const parsed = idParam.safeParse(raw);
    if (!parsed.success) throw httpError(400, `Invalid ${what}`);
    return parsed.data;
}

const templateTaskSchema = z
    .object({
        title: z.string().min(1).max(300),
        description: z.string().max(4000).nullable().optional(),
        department: z.enum(DEPARTMENTS).default('other'),
        // Role name ('it', 'hr', ...) or a numeric user id — resolved to
        // assignee_user_id at instantiation when it is numeric.
        assignee: z.string().max(100).nullable().optional(),
        assigneeRoleOrUser: z.string().max(100).nullable().optional(),
        offsetDays: z.number().int().min(0).max(3650).default(0),
        required: z.boolean().default(true),
        sortOrder: z.number().int().min(0).default(0)
    })
    .strict();

const createTemplateSchema = z
    .object({
        kind: z.enum(WORKFLOW_KINDS),
        name: z.string().min(1).max(200),
        active: z.boolean().default(true),
        tasks: z.array(templateTaskSchema).max(200).default([])
    })
    .strict();

const updateTemplateSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        active: z.boolean().optional(),
        // When present, the task list is REPLACED wholesale.
        tasks: z.array(templateTaskSchema).max(200).optional()
    })
    .strict();

const startWorkflowSchema = z
    .object({
        kind: z.enum(WORKFLOW_KINDS),
        templateId: z.number().int().positive().optional(),
        startDate: z.iso.date().optional()
    })
    .strict();

const completeTaskSchema = z
    .object({
        notes: z.string().max(2000).nullable().optional()
    })
    .strict();

const reasonSchema = z
    .object({
        reason: z.string().min(1).max(2000)
    })
    .strict();

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

const toIso = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
};

const toDateStr = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
};

/** due_at = start_date + offset_days (UTC midnight base). */
function addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString();
}

/** Numeric assignee strings resolve to a user id; role names stay unassigned. */
function resolveAssigneeUserId(assignee: string | null | undefined): number | null {
    if (!assignee) return null;
    return /^\d+$/.test(assignee) ? Number(assignee) : null;
}

function rowToTemplate(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        kind: row.kind,
        name: row.name,
        active: row.active === true,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at)
    };
}

function rowToTemplateTask(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        templateId: Number(row.template_id),
        title: row.title,
        description: row.description ?? null,
        department: row.department,
        assignee: row.assignee_role_or_user ?? null,
        offsetDays: Number(row.offset_days ?? 0),
        required: row.required === true,
        sortOrder: Number(row.sort_order ?? 0)
    };
}

function rowToWorkflow(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        employeeId: Number(row.employee_id),
        templateId: row.template_id != null ? Number(row.template_id) : null,
        kind: row.kind,
        status: row.status,
        startDate: toDateStr(row.start_date),
        startedAt: toIso(row.started_at),
        completedAt: toIso(row.completed_at),
        startedBy: row.started_by != null ? Number(row.started_by) : null,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
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

function rowToWorkflowTask(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        workflowId: Number(row.workflow_id),
        title: row.title,
        description: row.description ?? null,
        department: row.department,
        assigneeUserId: row.assignee_user_id != null ? Number(row.assignee_user_id) : null,
        required: row.required === true,
        sortOrder: Number(row.sort_order ?? 0),
        status: row.status,
        dueAt: toIso(row.due_at),
        completedAt: toIso(row.completed_at),
        completedBy: row.completed_by != null ? Number(row.completed_by) : null,
        statusReason: row.status_reason ?? null,
        notes: row.notes ?? null,
        createdAt: toIso(row.created_at)
    };
}

async function insertTemplateTasks(
    client: PoolClient,
    templateId: number,
    tasks: z.infer<typeof templateTaskSchema>[]
): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const t of tasks) {
        const { rows: inserted } = await client.query(
            `INSERT INTO workflow_template_tasks
                 (template_id, title, description, department, assignee_role_or_user, offset_days, required, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                templateId,
                t.title,
                t.description ?? null,
                t.department,
                t.assignee ?? t.assigneeRoleOrUser ?? null,
                t.offsetDays,
                t.required,
                t.sortOrder
            ]
        );
        rows.push(inserted[0]);
    }
    return rows;
}

async function templateTasks(client: Pool | PoolClient, templateId: number) {
    const { rows } = await client.query(
        `SELECT * FROM workflow_template_tasks WHERE template_id = $1 ORDER BY sort_order, id`,
        [templateId]
    );
    return rows;
}

/**
 * Auto-complete rollup: when no required task remains unresolved (a task is
 * resolved when done or skipped — blocked/pending/in_progress still count
 * as open), the workflow flips to completed in the same transaction.
 */
async function maybeAutoComplete(client: PoolClient, workflowId: number): Promise<boolean> {
    const { rows } = await client.query(
        `SELECT count(*) FILTER (WHERE required AND status NOT IN ('done','skipped'))::int AS pending_required
         FROM employee_workflow_tasks WHERE workflow_id = $1`,
        [workflowId]
    );
    if (Number(rows[0]?.pending_required ?? 0) > 0) return false;
    await client.query(
        `UPDATE employee_workflows
         SET status = 'completed', completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [workflowId]
    );
    return true;
}

const WORKFLOW_SELECT = `
    SELECT w.*, e.first_name AS employee_first_name, e.last_name AS employee_last_name,
           e.employee_number
    FROM employee_workflows w
    JOIN employees e ON e.id = w.employee_id
`;

async function fetchWorkflowTasks(
    client: Pool | PoolClient,
    workflowIds: number[],
    department?: string
): Promise<Map<number, Record<string, unknown>[]>> {
    const map = new Map<number, Record<string, unknown>[]>();
    if (workflowIds.length === 0) return map;
    const params: unknown[] = [workflowIds];
    let deptClause = '';
    if (department) {
        params.push(department);
        deptClause = ` AND department = $2`;
    }
    const { rows } = await client.query(
        `SELECT * FROM employee_workflow_tasks
         WHERE workflow_id = ANY($1)${deptClause}
         ORDER BY workflow_id, sort_order, id`,
        params
    );
    for (const row of rows) {
        const wid = Number(row.workflow_id);
        if (!map.has(wid)) map.set(wid, []);
        map.get(wid)!.push(row);
    }
    return map;
}

/**
 * Interdepartmental onboarding/offboarding workflows — template-driven task
 * lists spanning IT/HR/Finance/Facilities/Legal. Mounted at /v1 so it can
 * own /workflow-templates, /workflows, /workflow-tasks and the nested
 * /employees/:id/workflows paths (the employees router's single-segment
 * patterns never match the two-segment workflows path).
 */
export function workflowsRouter(deps: WorkflowsDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();

    // Every workflow route requires at least an authenticated caller —
    // service token or gateway user headers. HR-gating is per-route because
    // task completion also admits the task's assignee.
    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN));

    // ------------------------------------------------------------------
    // Templates — HR only.
    // ------------------------------------------------------------------

    // GET /v1/workflow-templates — every template with its task list.
    router.get('/workflow-templates', requireHR, async (_req, res, next) => {
        try {
            const { rows } = await pool.query(`SELECT * FROM workflow_templates ORDER BY kind, id`);
            const ids = rows.map((r) => Number(r.id));
            const { rows: tasks } = ids.length
                ? await pool.query(
                      `SELECT * FROM workflow_template_tasks
                       WHERE template_id = ANY($1) ORDER BY template_id, sort_order, id`,
                      [ids]
                  )
                : { rows: [] };
            const byTemplate = new Map<number, Record<string, unknown>[]>();
            for (const t of tasks) {
                const tid = Number(t.template_id);
                if (!byTemplate.has(tid)) byTemplate.set(tid, []);
                byTemplate.get(tid)!.push(t);
            }
            res.json(
                rows.map((r) => ({
                    ...rowToTemplate(r),
                    tasks: (byTemplate.get(Number(r.id)) ?? []).map(rowToTemplateTask)
                }))
            );
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/workflow-templates — create a template + its tasks in one tx.
    router.post('/workflow-templates', requireHR, async (req, res, next) => {
        try {
            const parsed = createTemplateSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid template payload', parsed.error.issues);
            const data = parsed.data;

            const created = await withTransaction(pool, async (client) => {
                let template;
                try {
                    ({
                        rows: [template]
                    } = await client.query(
                        `INSERT INTO workflow_templates (kind, name, active)
                         VALUES ($1, $2, $3) RETURNING *`,
                        [data.kind, data.name, data.active]
                    ));
                } catch (err) {
                    if (isUniqueViolation(err)) {
                        throw httpError(409, `A ${data.kind} template named '${data.name}' already exists`);
                    }
                    throw err;
                }
                const taskRows = await insertTemplateTasks(client, Number(template.id), data.tasks);
                return { template, taskRows };
            });

            log.info({ templateId: created.template.id, kind: data.kind }, 'workflow template created');
            res.status(201).json({
                ...rowToTemplate(created.template),
                tasks: created.taskRows.map(rowToTemplateTask)
            });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/workflow-templates/:id — template with tasks.
    router.get('/workflow-templates/:id(\\d+)', requireHR, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'template id');
            const { rows } = await pool.query(`SELECT * FROM workflow_templates WHERE id = $1`, [id]);
            if (!rows[0]) throw httpError(404, 'Workflow template not found');
            const tasks = await templateTasks(pool, id);
            res.json({ ...rowToTemplate(rows[0]), tasks: tasks.map(rowToTemplateTask) });
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/workflow-templates/:id — update name/active and (when `tasks`
    // is present) replace the task list wholesale, in one transaction.
    router.put('/workflow-templates/:id(\\d+)', requireHR, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'template id');
            const parsed = updateTemplateSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid template payload', parsed.error.issues);
            const data = parsed.data;
            if (data.name === undefined && data.active === undefined && data.tasks === undefined) {
                throw httpError(400, 'No fields to update');
            }

            const outcome = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM workflow_templates WHERE id = $1 FOR UPDATE`, [id]);
                if (!rows[0]) throw httpError(404, 'Workflow template not found');
                if (data.name !== undefined || data.active !== undefined) {
                    try {
                        await client.query(
                            `UPDATE workflow_templates
                             SET name = COALESCE($2, name),
                                 active = COALESCE($3, active),
                                 updated_at = now()
                             WHERE id = $1`,
                            [id, data.name ?? null, data.active ?? null]
                        );
                    } catch (err) {
                        if (isUniqueViolation(err)) {
                            throw httpError(409, `A template named '${data.name}' already exists for this kind`);
                        }
                        throw err;
                    }
                }
                let taskRows: Record<string, unknown>[] | null = null;
                if (data.tasks !== undefined) {
                    await client.query(`DELETE FROM workflow_template_tasks WHERE template_id = $1`, [id]);
                    taskRows = await insertTemplateTasks(client, id, data.tasks);
                }
                const { rows: fresh } = await client.query(`SELECT * FROM workflow_templates WHERE id = $1`, [id]);
                return { template: fresh[0], taskRows };
            });

            const tasks = outcome.taskRows ?? (await templateTasks(pool, id));
            res.json({ ...rowToTemplate(outcome.template), tasks: tasks.map(rowToTemplateTask) });
        } catch (err) {
            next(err);
        }
    });

    // ------------------------------------------------------------------
    // Workflow instances.
    // ------------------------------------------------------------------

    /**
     * POST /v1/employees/:id/workflows — instantiate a workflow. When
     * templateId is omitted the first active template of that kind is used.
     * Task due dates derive from startDate + offset_days; numeric template
     * assignees become assignee_user_id, role names stay unassigned.
     */
    router.post('/employees/:id(\\d+)/workflows', requireHR, async (req, res, next) => {
        try {
            const employeeId = parseId(req.params.id, 'employee id');
            const parsed = startWorkflowSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid workflow payload', parsed.error.issues);
            const { kind, templateId } = parsed.data;
            const startDate = parsed.data.startDate ?? new Date().toISOString().slice(0, 10);
            const startedBy = req.user?.userId ?? null;

            const created = await withTransaction(pool, async (client) => {
                const { rows: emp } = await client.query(
                    `SELECT id FROM employees WHERE id = $1 AND deleted_at IS NULL`,
                    [employeeId]
                );
                if (!emp[0]) throw httpError(404, 'Employee not found');

                let template: Record<string, unknown> | undefined;
                if (templateId !== undefined) {
                    const { rows } = await client.query(`SELECT * FROM workflow_templates WHERE id = $1`, [templateId]);
                    template = rows[0];
                    if (!template) throw httpError(404, 'Workflow template not found');
                    if (template.kind !== kind) {
                        throw httpError(400, `Template ${templateId} is a ${template.kind} template, not ${kind}`);
                    }
                } else {
                    const { rows } = await client.query(
                        `SELECT * FROM workflow_templates
                         WHERE kind = $1 AND active ORDER BY id LIMIT 1`,
                        [kind]
                    );
                    template = rows[0];
                    if (!template) throw httpError(404, `No active ${kind} template exists`);
                }

                let workflow;
                try {
                    ({
                        rows: [workflow]
                    } = await client.query(
                        `INSERT INTO employee_workflows
                             (employee_id, template_id, kind, status, start_date, started_by)
                         VALUES ($1, $2, $3, 'active', $4, $5) RETURNING *`,
                        [employeeId, template.id, kind, startDate, startedBy]
                    ));
                } catch (err) {
                    if (isUniqueViolation(err)) {
                        throw httpError(409, `An active ${kind} workflow already exists for this employee`);
                    }
                    throw err;
                }

                const { rows: tmplTasks } = await client.query(
                    `SELECT * FROM workflow_template_tasks
                     WHERE template_id = $1 ORDER BY sort_order, id`,
                    [template.id]
                );
                const taskRows: Record<string, unknown>[] = [];
                for (const t of tmplTasks) {
                    const { rows: inserted } = await client.query(
                        `INSERT INTO employee_workflow_tasks
                             (workflow_id, title, description, department, assignee_user_id,
                              required, sort_order, due_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                        [
                            workflow.id,
                            t.title,
                            t.description ?? null,
                            t.department,
                            resolveAssigneeUserId(t.assignee_role_or_user as string | null),
                            t.required,
                            t.sort_order,
                            addDays(startDate, Number(t.offset_days ?? 0))
                        ]
                    );
                    taskRows.push(inserted[0]);
                }

                await enqueueEvent(
                    client,
                    'strafor.hr.workflow_started',
                    {
                        workflowId: Number(workflow.id),
                        employeeId,
                        kind,
                        templateId: Number(template.id),
                        taskCount: taskRows.length
                    },
                    req.correlationId
                );
                return { workflow, taskRows };
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            log.info({ workflowId: created.workflow.id, employeeId, kind }, 'employee workflow started');
            res.status(201).json({
                ...rowToWorkflow(created.workflow),
                tasks: created.taskRows.map(rowToWorkflowTask)
            });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/employees/:id/workflows — an employee's workflows with tasks.
    router.get('/employees/:id(\\d+)/workflows', requireHR, async (req, res, next) => {
        try {
            const employeeId = parseId(req.params.id, 'employee id');
            const { rows } = await pool.query(
                `${WORKFLOW_SELECT} WHERE w.employee_id = $1 ORDER BY w.created_at DESC`,
                [employeeId]
            );
            const tasksByWf = await fetchWorkflowTasks(
                pool,
                rows.map((r) => Number(r.id))
            );
            res.json(
                rows.map((r) => ({
                    ...rowToWorkflow(r),
                    tasks: (tasksByWf.get(Number(r.id)) ?? []).map(rowToWorkflowTask)
                }))
            );
        } catch (err) {
            next(err);
        }
    });

    /**
     * GET /v1/workflows — HR dashboard list. Filters (allowlisted):
     *   status      workflow status
     *   employeeId  owning employee
     *   department  workflows having tasks in that department; the embedded
     *               task list is then limited to that department.
     */
    router.get('/workflows', requireHR, async (req, res, next) => {
        try {
            const where: string[] = ['TRUE'];
            const params: unknown[] = [];
            const q = req.query as Record<string, unknown>;
            const status = typeof q.status === 'string' ? q.status : undefined;
            const department = typeof q.department === 'string' ? q.department : undefined;
            const employeeId = typeof q.employeeId === 'string' ? q.employeeId : undefined;

            if (status) {
                if (!(WORKFLOW_STATUSES as readonly string[]).includes(status)) {
                    throw httpError(400, `Invalid status filter '${status}'`);
                }
                params.push(status);
                where.push(`w.status = $${params.length}`);
            }
            if (employeeId) {
                const eid = parseId(employeeId, 'employeeId');
                params.push(eid);
                where.push(`w.employee_id = $${params.length}`);
            }
            if (department) {
                if (!(DEPARTMENTS as readonly string[]).includes(department)) {
                    throw httpError(400, `Invalid department filter '${department}'`);
                }
                params.push(department);
                where.push(
                    `EXISTS (SELECT 1 FROM employee_workflow_tasks t
                             WHERE t.workflow_id = w.id AND t.department = $${params.length})`
                );
            }

            const { rows } = await pool.query(
                `${WORKFLOW_SELECT} WHERE ${where.join(' AND ')} ORDER BY w.created_at DESC`,
                params
            );
            const tasksByWf = await fetchWorkflowTasks(
                pool,
                rows.map((r) => Number(r.id)),
                department
            );
            res.json(
                rows.map((r) => ({
                    ...rowToWorkflow(r),
                    tasks: (tasksByWf.get(Number(r.id)) ?? []).map(rowToWorkflowTask)
                }))
            );
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/workflows/:id — workflow detail with its full task list.
    router.get('/workflows/:id(\\d+)', requireHR, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'workflow id');
            const { rows } = await pool.query(`${WORKFLOW_SELECT} WHERE w.id = $1`, [id]);
            if (!rows[0]) throw httpError(404, 'Workflow not found');
            const tasksByWf = await fetchWorkflowTasks(pool, [id]);
            res.json({
                ...rowToWorkflow(rows[0]),
                tasks: (tasksByWf.get(id) ?? []).map(rowToWorkflowTask)
            });
        } catch (err) {
            next(err);
        }
    });

    // ------------------------------------------------------------------
    // Task transitions.
    // ------------------------------------------------------------------

    /**
     * POST /v1/workflow-tasks/:id/complete — mark a task done.
     * Allowed for trusted service callers, HR users, and the task's
     * assignee (x-user-id === assignee_user_id — a real user identity, a
     * service token cannot claim the assignee path).
     * Completing the last required task auto-completes the workflow in the
     * same transaction.
     */
    router.post('/workflow-tasks/:id(\\d+)/complete', async (req, res, next) => {
        try {
            const taskId = parseId(req.params.id, 'task id');
            const parsed = completeTaskSchema.safeParse(req.body ?? {});
            if (!parsed.success) throw httpError(400, 'Invalid completion payload', parsed.error.issues);

            const outcome = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `SELECT t.*, w.status AS workflow_status, w.employee_id, w.kind AS workflow_kind
                     FROM employee_workflow_tasks t
                     JOIN employee_workflows w ON w.id = t.workflow_id
                     WHERE t.id = $1
                     FOR UPDATE OF t, w`,
                    [taskId]
                );
                const task = rows[0];
                if (!task) throw httpError(404, 'Workflow task not found');

                const isService = req.caller?.kind === 'service';
                const isHR = req.user?.role === 'hr';
                const isAssignee =
                    req.user != null &&
                    task.assignee_user_id != null &&
                    req.user.userId === Number(task.assignee_user_id);
                if (!isService && !isHR && !isAssignee) {
                    throw httpError(403, 'Not allowed to complete this task');
                }
                if (task.workflow_status !== 'active') {
                    throw httpError(409, `Workflow is already ${task.workflow_status}`);
                }
                if (['done', 'skipped'].includes(task.status)) {
                    throw httpError(409, `Task is already ${task.status}`);
                }

                const completedBy = req.user?.userId ?? null;
                const { rows: updated } = await client.query(
                    `UPDATE employee_workflow_tasks
                     SET status = 'done',
                         completed_at = now(),
                         completed_by = $2,
                         notes = CASE WHEN $3::boolean THEN $4 ELSE notes END,
                         updated_at = now()
                     WHERE id = $1
                     RETURNING *`,
                    [taskId, completedBy, parsed.data.notes !== undefined, parsed.data.notes ?? null]
                );

                const workflowCompleted = await maybeAutoComplete(client, Number(task.workflow_id));

                await enqueueEvent(
                    client,
                    'strafor.hr.workflow_task_completed',
                    {
                        workflowId: Number(task.workflow_id),
                        taskId,
                        department: task.department,
                        title: task.title,
                        completedBy
                    },
                    req.correlationId
                );
                if (workflowCompleted) {
                    await enqueueEvent(
                        client,
                        'strafor.hr.workflow_completed',
                        {
                            workflowId: Number(task.workflow_id),
                            employeeId: Number(task.employee_id),
                            kind: task.workflow_kind
                        },
                        req.correlationId
                    );
                }

                const { rows: wfRows } = await client.query(`${WORKFLOW_SELECT} WHERE w.id = $1`, [task.workflow_id]);
                return { task: updated[0], workflow: wfRows[0], workflowCompleted };
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            res.json({
                task: rowToWorkflowTask(outcome.task),
                workflow: outcome.workflow ? rowToWorkflow(outcome.workflow) : null,
                workflowCompleted: outcome.workflowCompleted
            });
        } catch (err) {
            next(err);
        }
    });

    /**
     * POST /v1/workflow-tasks/:id/block|skip — HR-only status overrides.
     * `{reason}` is required and stored in status_reason. Skipping the last
     * unresolved required task also completes the workflow.
     */
    for (const [action, status] of [
        ['block', 'blocked'],
        ['skip', 'skipped']
    ] as const) {
        router.post(`/workflow-tasks/:id(\\d+)/${action}`, requireHR, async (req, res, next) => {
            try {
                const taskId = parseId(req.params.id, 'task id');
                const parsed = reasonSchema.safeParse(req.body);
                if (!parsed.success) {
                    throw httpError(400, `A reason is required to ${action} a task`, parsed.error.issues);
                }

                const outcome = await withTransaction(pool, async (client) => {
                    const { rows } = await client.query(
                        `SELECT t.*, w.status AS workflow_status, w.employee_id, w.kind AS workflow_kind
                         FROM employee_workflow_tasks t
                         JOIN employee_workflows w ON w.id = t.workflow_id
                         WHERE t.id = $1
                         FOR UPDATE OF t, w`,
                        [taskId]
                    );
                    const task = rows[0];
                    if (!task) throw httpError(404, 'Workflow task not found');
                    if (task.workflow_status !== 'active') {
                        throw httpError(409, `Workflow is already ${task.workflow_status}`);
                    }
                    if (['done', 'skipped'].includes(task.status)) {
                        throw httpError(409, `Task is already ${task.status}`);
                    }

                    const { rows: updated } = await client.query(
                        `UPDATE employee_workflow_tasks
                         SET status = $2, status_reason = $3, updated_at = now()
                         WHERE id = $1
                         RETURNING *`,
                        [taskId, status, parsed.data.reason]
                    );

                    const workflowCompleted =
                        status === 'skipped' ? await maybeAutoComplete(client, Number(task.workflow_id)) : false;
                    if (workflowCompleted) {
                        await enqueueEvent(
                            client,
                            'strafor.hr.workflow_completed',
                            {
                                workflowId: Number(task.workflow_id),
                                employeeId: Number(task.employee_id),
                                kind: task.workflow_kind
                            },
                            req.correlationId
                        );
                    }

                    const { rows: wfRows } = await client.query(`${WORKFLOW_SELECT} WHERE w.id = $1`, [
                        task.workflow_id
                    ]);
                    return { task: updated[0], workflow: wfRows[0], workflowCompleted };
                });
                await flushOutbox(pool, publisher, log).catch(() => 0);

                res.json({
                    task: rowToWorkflowTask(outcome.task),
                    workflow: outcome.workflow ? rowToWorkflow(outcome.workflow) : null,
                    workflowCompleted: outcome.workflowCompleted
                });
            } catch (err) {
                next(err);
            }
        });
    }

    return router;
}
