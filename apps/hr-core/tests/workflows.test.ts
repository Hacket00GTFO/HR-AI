// Interdepartmental workflow tests — stubbed pool (with outbox emulation),
// no live DB. Covers template CRUD, instantiation with offset due dates,
// assignee-vs-HR completion authz, auto-complete on the last required task,
// 409 transitions and the admin→403 matrix.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { ADMIN, EMPLOYEE, EMPLOYEE_B, HR, SERVICE, testApp, type SqlHandler } from './helpers.js';

const TEMPLATE = {
    id: 7,
    kind: 'onboarding',
    name: 'Onboarding MX',
    active: true,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z'
};

const TMPL_TASKS = [
    {
        id: 71,
        template_id: 7,
        title: 'Crear cuentas de acceso',
        description: 'Correo, VPN, sistemas',
        department: 'it',
        assignee_role_or_user: 'it',
        offset_days: 0,
        required: true,
        sort_order: 10,
        created_at: '2025-01-01T00:00:00.000Z'
    },
    {
        id: 72,
        template_id: 7,
        title: 'Contrato firmado',
        description: null,
        department: 'hr',
        assignee_role_or_user: '10',
        offset_days: 3,
        required: true,
        sort_order: 20,
        created_at: '2025-01-01T00:00:00.000Z'
    },
    {
        id: 73,
        template_id: 7,
        title: 'Acceso a sede',
        description: null,
        department: 'facilities',
        assignee_role_or_user: null,
        offset_days: 1,
        required: false,
        sort_order: 30,
        created_at: '2025-01-01T00:00:00.000Z'
    }
];

const WF = {
    id: 21,
    employee_id: 3,
    template_id: 7,
    kind: 'onboarding',
    status: 'active',
    start_date: '2025-01-10',
    started_at: '2025-01-10T00:00:00.000Z',
    completed_at: null,
    started_by: 2,
    created_at: '2025-01-10T00:00:00.000Z',
    updated_at: '2025-01-10T00:00:00.000Z'
};

const TASK_JOIN = {
    id: 55,
    workflow_id: 21,
    title: 'Crear cuentas de acceso',
    description: null,
    department: 'it',
    assignee_user_id: 10,
    required: true,
    sort_order: 10,
    status: 'pending',
    due_at: '2025-01-10T00:00:00.000Z',
    completed_at: null,
    completed_by: null,
    status_reason: null,
    notes: null,
    created_at: '2025-01-10T00:00:00.000Z',
    updated_at: '2025-01-10T00:00:00.000Z',
    workflow_status: 'active',
    employee_id: 3,
    workflow_kind: 'onboarding'
};

// --------------------------------------------------------------------------
// Template CRUD
// --------------------------------------------------------------------------

describe('POST /v1/workflow-templates', () => {
    it('creates a template with its task list in one transaction', async () => {
        const { app, stub } = testApp((text, params) => {
            if (text.includes('INSERT INTO workflow_templates')) return { rows: [TEMPLATE] };
            if (text.includes('INSERT INTO workflow_template_tasks')) {
                return {
                    rows: [
                        {
                            id: 100,
                            template_id: params[0],
                            title: params[1],
                            description: params[2],
                            department: params[3],
                            assignee_role_or_user: params[4],
                            offset_days: params[5],
                            required: params[6],
                            sort_order: params[7],
                            created_at: 'x'
                        }
                    ]
                };
            }
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/workflow-templates')
            .set(HR)
            .send({
                kind: 'onboarding',
                name: 'Onboarding MX',
                tasks: [
                    {
                        title: 'Crear cuentas de acceso',
                        department: 'it',
                        offsetDays: 0,
                        required: true,
                        sortOrder: 10
                    },
                    { title: 'Contrato firmado', department: 'hr', assignee: '10', offsetDays: 3 }
                ]
            });
        expect(res.status).toBe(201);
        expect(res.body.name).toBe('Onboarding MX');
        expect(res.body.tasks).toHaveLength(2);
        expect(res.body.tasks[0].department).toBe('it');
        expect(res.body.tasks[1].assignee).toBe('10');
        const sql = stub.queryTexts();
        expect(sql[0]).toBe('BEGIN');
        expect(sql.at(-1)).toBe('COMMIT');
        expect(sql.filter((t) => t.includes('INSERT INTO workflow_template_tasks'))).toHaveLength(2);
    });

    it('409 on duplicate (kind, name)', async () => {
        const { app } = testApp((text) => {
            if (text.includes('INSERT INTO workflow_templates')) {
                const err = new Error('duplicate') as Error & { code: string };
                err.code = '23505';
                throw err;
            }
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/workflow-templates')
            .set(HR)
            .send({ kind: 'onboarding', name: 'Onboarding MX' });
        expect(res.status).toBe(409);
    });

    it('400 on invalid kind', async () => {
        const { app } = testApp();
        const res = await request(app).post('/v1/workflow-templates').set(HR).send({ kind: 'review', name: 'X' });
        expect(res.status).toBe(400);
    });
});

describe('GET /v1/workflow-templates', () => {
    it('lists templates with their tasks', async () => {
        const { app } = testApp((text) => {
            if (text.includes('FROM workflow_templates ORDER BY')) return { rows: [TEMPLATE] };
            if (text.includes('FROM workflow_template_tasks') && text.includes('ANY')) {
                return { rows: TMPL_TASKS };
            }
            return { rows: [] };
        });
        const res = await request(app).get('/v1/workflow-templates').set(HR);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].id).toBe(7);
        expect(res.body[0].tasks).toHaveLength(3);
        expect(res.body[0].tasks[0].title).toBe('Crear cuentas de acceso');
    });

    it('GET /v1/workflow-templates/:id returns the template with tasks; 404 when missing', async () => {
        const { app } = testApp((text, params) => {
            if (text.includes('FROM workflow_templates WHERE id')) {
                return { rows: Number(params[0]) === 7 ? [TEMPLATE] : [] };
            }
            if (text.includes('FROM workflow_template_tasks')) return { rows: TMPL_TASKS };
            return { rows: [] };
        });
        const res = await request(app).get('/v1/workflow-templates/7').set(HR);
        expect(res.status).toBe(200);
        expect(res.body.tasks).toHaveLength(3);
        expect(res.body.tasks[1].offsetDays).toBe(3);

        const missing = await request(app).get('/v1/workflow-templates/999').set(HR);
        expect(missing.status).toBe(404);
    });
});

describe('PUT /v1/workflow-templates/:id', () => {
    it('updates fields and replaces the task list in one transaction', async () => {
        const { app, stub } = testApp((text, params) => {
            if (text.includes('FOR UPDATE')) return { rows: [TEMPLATE] };
            if (text.includes('INSERT INTO workflow_template_tasks')) {
                return {
                    rows: [
                        {
                            id: 200,
                            template_id: 7,
                            title: params[1],
                            description: null,
                            department: params[3],
                            assignee_role_or_user: null,
                            offset_days: params[5],
                            required: params[6],
                            sort_order: params[7],
                            created_at: 'x'
                        }
                    ]
                };
            }
            if (text.includes('FROM workflow_templates WHERE id')) {
                return { rows: [{ ...TEMPLATE, active: false }] };
            }
            return { rows: [] };
        });
        const res = await request(app)
            .put('/v1/workflow-templates/7')
            .set(HR)
            .send({ active: false, tasks: [{ title: 'Nueva tarea', department: 'legal', required: true }] });
        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        expect(res.body.tasks).toHaveLength(1);
        expect(res.body.tasks[0].title).toBe('Nueva tarea');
        const sql = stub.queryTexts();
        expect(sql[0]).toBe('BEGIN');
        expect(sql).toContain('COMMIT');
        expect(sql.some((t) => t.includes('DELETE FROM workflow_template_tasks'))).toBe(true);
    });

    it('400 with no fields; 404 when missing', async () => {
        const { app } = testApp((text) => {
            if (text.includes('FOR UPDATE')) return { rows: [] };
            return { rows: [] };
        });
        const noFields = await request(app).put('/v1/workflow-templates/7').set(HR).send({});
        expect(noFields.status).toBe(400);
        const missing = await request(app).put('/v1/workflow-templates/7').set(HR).send({ active: false });
        expect(missing.status).toBe(404);
    });
});

// --------------------------------------------------------------------------
// Instantiation
// --------------------------------------------------------------------------

describe('POST /v1/employees/:id/workflows', () => {
    const startHandler = (): SqlHandler => (text, params) => {
        if (text.startsWith('SELECT id FROM employees')) return { rows: [{ id: 3 }] };
        if (text.includes('FROM workflow_templates WHERE id')) return { rows: [TEMPLATE] };
        if (text.includes('FROM workflow_templates') && text.includes('AND active')) return { rows: [TEMPLATE] };
        if (text.includes('INSERT INTO employee_workflows')) return { rows: [WF] };
        if (text.includes('FROM workflow_template_tasks')) return { rows: TMPL_TASKS };
        if (text.includes('INSERT INTO employee_workflow_tasks')) {
            return {
                rows: [
                    {
                        id: Number(params[6]) + 500,
                        workflow_id: params[0],
                        title: params[1],
                        description: params[2],
                        department: params[3],
                        assignee_user_id: params[4],
                        required: params[5],
                        sort_order: params[6],
                        status: 'pending',
                        due_at: params[7],
                        completed_at: null,
                        completed_by: null,
                        status_reason: null,
                        notes: null,
                        created_at: '2025-01-10T00:00:00.000Z',
                        updated_at: '2025-01-10T00:00:00.000Z'
                    }
                ]
            };
        }
        return { rows: [] };
    };

    it('instantiates from an explicit template with offset due dates', async () => {
        const { app, stub, publisher } = testApp(startHandler());
        const res = await request(app)
            .post('/v1/employees/3/workflows')
            .set(HR)
            .send({ kind: 'onboarding', templateId: 7, startDate: '2025-01-10' });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('active');
        expect(res.body.tasks).toHaveLength(3);

        // due_at = startDate + offsetDays (2025-01-10 base).
        const taskInserts = stub.calls.filter((c) => c.text.includes('INSERT INTO employee_workflow_tasks'));
        expect(taskInserts[0].params[7]).toBe('2025-01-10T00:00:00.000Z'); // offset 0
        expect(taskInserts[1].params[7]).toBe('2025-01-13T00:00:00.000Z'); // offset 3
        expect(taskInserts[2].params[7]).toBe('2025-01-11T00:00:00.000Z'); // offset 1
        // Role assignees stay unassigned; numeric assignees resolve to user ids.
        expect(taskInserts[0].params[4]).toBeNull(); // 'it' role
        expect(taskInserts[1].params[4]).toBe(10); // '10' user id

        // workflow_started went through the outbox in the same tx.
        const outboxInsert = stub.calls.find((c) => c.text.includes('INSERT INTO outbox_events'));
        expect(outboxInsert?.params[0]).toBe('strafor.hr.workflow_started');
        expect(publisher.published).toEqual([
            {
                type: 'strafor.hr.workflow_started',
                payload: { workflowId: 21, employeeId: 3, kind: 'onboarding', templateId: 7, taskCount: 3 }
            }
        ]);
    });

    it('falls back to the active template of that kind when templateId is omitted', async () => {
        const { app, stub } = testApp(startHandler());
        const res = await request(app)
            .post('/v1/employees/3/workflows')
            .set(HR)
            .send({ kind: 'onboarding', startDate: '2025-01-10' });
        expect(res.status).toBe(201);
        const defaultLookup = stub.calls.find(
            (c) => c.text.includes('FROM workflow_templates') && c.text.includes('AND active')
        );
        expect(defaultLookup?.params).toEqual(['onboarding']);
    });

    it('400 when template kind mismatches; 404 for employee/template', async () => {
        const { app } = testApp((text) => {
            if (text.startsWith('SELECT id FROM employees')) return { rows: [{ id: 3 }] };
            if (text.includes('FROM workflow_templates WHERE id')) {
                return { rows: [{ ...TEMPLATE, kind: 'offboarding' }] };
            }
            return { rows: [] };
        });
        const mismatch = await request(app)
            .post('/v1/employees/3/workflows')
            .set(HR)
            .send({ kind: 'onboarding', templateId: 7, startDate: '2025-01-10' });
        expect(mismatch.status).toBe(400);

        const { app: noEmp } = testApp(() => ({ rows: [] }));
        const res404 = await request(noEmp)
            .post('/v1/employees/999/workflows')
            .set(HR)
            .send({ kind: 'onboarding', startDate: '2025-01-10' });
        expect(res404.status).toBe(404);

        const { app: noTmpl } = testApp((text) => {
            if (text.startsWith('SELECT id FROM employees')) return { rows: [{ id: 3 }] };
            return { rows: [] };
        });
        const resNoTmpl = await request(noTmpl)
            .post('/v1/employees/3/workflows')
            .set(HR)
            .send({ kind: 'offboarding', startDate: '2025-01-10' });
        expect(resNoTmpl.status).toBe(404);
    });

    it('409 when an active workflow of that kind already exists', async () => {
        const { app } = testApp((text) => {
            if (text.startsWith('SELECT id FROM employees')) return { rows: [{ id: 3 }] };
            if (text.includes('FROM workflow_templates WHERE id')) return { rows: [TEMPLATE] };
            if (text.includes('INSERT INTO employee_workflows')) {
                const err = new Error('duplicate') as Error & { code: string };
                err.code = '23505';
                throw err;
            }
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/employees/3/workflows')
            .set(HR)
            .send({ kind: 'onboarding', templateId: 7, startDate: '2025-01-10' });
        expect(res.status).toBe(409);
    });
});

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

describe('workflow reads', () => {
    it('GET /v1/employees/:id/workflows returns workflows with tasks', async () => {
        const { app } = testApp((text) => {
            if (text.includes('JOIN employees e') && text.includes('w.employee_id')) return { rows: [WF] };
            if (text.includes('FROM employee_workflow_tasks') && text.includes('ANY')) {
                return { rows: [TASK_JOIN] };
            }
            return { rows: [] };
        });
        const res = await request(app).get('/v1/employees/3/workflows').set(HR);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].id).toBe(21);
        expect(res.body[0].tasks[0].title).toBe('Crear cuentas de acceso');
    });

    it('GET /v1/workflows/:id returns detail; 404 when missing', async () => {
        const { app } = testApp((text, params) => {
            if (text.includes('JOIN employees e') && text.includes('w.id')) {
                return { rows: Number(params[0]) === 21 ? [WF] : [] };
            }
            if (text.includes('FROM employee_workflow_tasks')) return { rows: [TASK_JOIN] };
            return { rows: [] };
        });
        const res = await request(app).get('/v1/workflows/21').set(HR);
        expect(res.status).toBe(200);
        expect(res.body.kind).toBe('onboarding');
        expect(res.body.tasks).toHaveLength(1);

        const missing = await request(app).get('/v1/workflows/999').set(HR);
        expect(missing.status).toBe(404);
    });

    it('GET /v1/workflows filters by status/department/employeeId', async () => {
        const { app, stub } = testApp((text) => {
            if (text.includes('JOIN employees e')) return { rows: [WF] };
            if (text.includes('FROM employee_workflow_tasks')) return { rows: [TASK_JOIN] };
            return { rows: [] };
        });
        const res = await request(app).get('/v1/workflows?status=active&department=it&employeeId=3').set(HR);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        const listQuery = stub.calls.find((c) => c.text.includes('EXISTS'));
        expect(listQuery).toBeDefined();
        expect(listQuery!.params).toEqual(['active', 3, 'it']);
        // The embedded task list is limited to the requested department.
        const taskQuery = stub.calls.find((c) => c.text.includes('workflow_id = ANY'));
        expect(taskQuery!.text).toContain('AND department = $2');
        expect(taskQuery!.params[1]).toBe('it');
    });

    it('GET /v1/workflows rejects invalid filter values', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/workflows?status=bogus').set(HR);
        expect(res.status).toBe(400);
        const resDept = await request(app).get('/v1/workflows?department=bogus').set(HR);
        expect(resDept.status).toBe(400);
    });
});

// --------------------------------------------------------------------------
// Task completion — HR vs assignee authz + auto-complete
// --------------------------------------------------------------------------

describe('POST /v1/workflow-tasks/:id/complete', () => {
    const completeFlow =
        (pendingRequired: number, task: Record<string, unknown> = TASK_JOIN): SqlHandler =>
        (text, params) => {
            if (text.includes('FOR UPDATE OF t, w')) return { rows: [task] };
            if (text.includes('UPDATE employee_workflow_tasks')) {
                return {
                    rows: [
                        {
                            ...task,
                            status: 'done',
                            completed_at: '2025-01-11T00:00:00.000Z',
                            completed_by: params[1],
                            notes: params[2] === true ? params[3] : task.notes
                        }
                    ]
                };
            }
            if (text.includes('pending_required')) return { rows: [{ pending_required: pendingRequired }] };
            if (text.includes('UPDATE employee_workflows')) return { rows: [] };
            if (text.includes('JOIN employees e')) {
                return { rows: [{ ...WF, status: pendingRequired === 0 ? 'completed' : 'active' }] };
            }
            return { rows: [] };
        };

    it('HR can complete any task', async () => {
        const { app, publisher } = testApp(completeFlow(1));
        const res = await request(app).post('/v1/workflow-tasks/55/complete').set(HR).send({ notes: 'done' });
        expect(res.status).toBe(200);
        expect(res.body.task.status).toBe('done');
        expect(res.body.task.completedBy).toBe(2);
        expect(res.body.workflowCompleted).toBe(false);
        expect(publisher.published).toEqual([
            {
                type: 'strafor.hr.workflow_task_completed',
                payload: {
                    workflowId: 21,
                    taskId: 55,
                    department: 'it',
                    title: 'Crear cuentas de acceso',
                    completedBy: 2
                }
            }
        ]);
    });

    it('the assignee (x-user-id === assignee_user_id) can complete their task', async () => {
        const { app } = testApp(completeFlow(1));
        const res = await request(app).post('/v1/workflow-tasks/55/complete').set(EMPLOYEE).send({});
        expect(res.status).toBe(200);
        expect(res.body.task.completedBy).toBe(10);
    });

    it('a non-assignee employee gets 403; a service token is trusted', async () => {
        const { app } = testApp(completeFlow(1));
        const res = await request(app).post('/v1/workflow-tasks/55/complete').set(EMPLOYEE_B).send({});
        expect(res.status).toBe(403);
        const svc = await request(app).post('/v1/workflow-tasks/55/complete').set(SERVICE).send({});
        expect(svc.status).toBe(200);
    });

    it('completing the last required task auto-completes the workflow in the same tx', async () => {
        const { app, stub, publisher } = testApp(completeFlow(0));
        const res = await request(app).post('/v1/workflow-tasks/55/complete').set(HR).send({});
        expect(res.status).toBe(200);
        expect(res.body.workflowCompleted).toBe(true);
        expect(res.body.workflow.status).toBe('completed');

        const sql = stub.queryTexts();
        const commitIdx = sql.indexOf('COMMIT');
        const wfUpdateIdx = sql.findIndex(
            (t) => t.includes('UPDATE employee_workflows') && !t.includes('employee_workflow_tasks')
        );
        expect(wfUpdateIdx).toBeGreaterThan(-1);
        expect(wfUpdateIdx).toBeLessThan(commitIdx);
        const completedEvent = stub.calls.find(
            (c) => c.text.includes('INSERT INTO outbox_events') && c.params[0] === 'strafor.hr.workflow_completed'
        );
        expect(completedEvent).toBeDefined();
        expect(publisher.published.map((p) => p.type)).toEqual([
            'strafor.hr.workflow_task_completed',
            'strafor.hr.workflow_completed'
        ]);
        expect(publisher.published[1].payload).toEqual({
            workflowId: 21,
            employeeId: 3,
            kind: 'onboarding'
        });
    });

    it('409 completing twice; 409 on a cancelled workflow; 404 unknown task', async () => {
        const { app } = testApp(completeFlow(1, { ...TASK_JOIN, status: 'done' }));
        const twice = await request(app).post('/v1/workflow-tasks/55/complete').set(HR).send({});
        expect(twice.status).toBe(409);

        const { app: cancelled } = testApp(completeFlow(1, { ...TASK_JOIN, workflow_status: 'cancelled' }));
        const resC = await request(cancelled).post('/v1/workflow-tasks/55/complete').set(HR).send({});
        expect(resC.status).toBe(409);
        expect(resC.body.error).toMatch(/cancelled/i);

        const { app: missing } = testApp(() => ({ rows: [] }));
        const res404 = await request(missing).post('/v1/workflow-tasks/999/complete').set(HR).send({});
        expect(res404.status).toBe(404);
    });
});

// --------------------------------------------------------------------------
// Block / skip — HR only
// --------------------------------------------------------------------------

describe('POST /v1/workflow-tasks/:id/block|skip', () => {
    const transitionFlow =
        (task: Record<string, unknown> = TASK_JOIN, pendingRequired = 2): SqlHandler =>
        (text, params) => {
            if (text.includes('FOR UPDATE OF t, w')) return { rows: [task] };
            if (text.includes('UPDATE employee_workflow_tasks')) {
                return { rows: [{ ...task, status: params[1], status_reason: params[2] }] };
            }
            if (text.includes('pending_required')) return { rows: [{ pending_required: pendingRequired }] };
            if (text.includes('UPDATE employee_workflows')) return { rows: [] };
            if (text.includes('JOIN employees e')) {
                return { rows: [{ ...WF, status: pendingRequired === 0 ? 'completed' : 'active' }] };
            }
            return { rows: [] };
        };

    it('HR blocks a task with a reason', async () => {
        const { app } = testApp(transitionFlow());
        const res = await request(app)
            .post('/v1/workflow-tasks/55/block')
            .set(HR)
            .send({ reason: 'waiting on vendor' });
        expect(res.status).toBe(200);
        expect(res.body.task.status).toBe('blocked');
        expect(res.body.task.statusReason).toBe('waiting on vendor');
    });

    it('HR skips a task; skipping the last required task completes the workflow', async () => {
        const { app, publisher } = testApp(transitionFlow(TASK_JOIN, 0));
        const res = await request(app).post('/v1/workflow-tasks/55/skip').set(HR).send({ reason: 'not applicable' });
        expect(res.status).toBe(200);
        expect(res.body.task.status).toBe('skipped');
        expect(res.body.workflowCompleted).toBe(true);
        expect(publisher.published.map((p) => p.type)).toEqual(['strafor.hr.workflow_completed']);
    });

    it('400 without a reason; 409 on terminal task/workflow states', async () => {
        const { app } = testApp(transitionFlow());
        const noReason = await request(app).post('/v1/workflow-tasks/55/block').set(HR).send({});
        expect(noReason.status).toBe(400);

        const { app: doneTask } = testApp(transitionFlow({ ...TASK_JOIN, status: 'done' }));
        const resDone = await request(doneTask).post('/v1/workflow-tasks/55/skip').set(HR).send({ reason: 'x' });
        expect(resDone.status).toBe(409);
    });
});

// --------------------------------------------------------------------------
// Authz matrix — admin gets 403 everywhere; unauthenticated gets 401
// --------------------------------------------------------------------------

describe('admin → 403 matrix on workflow routes', () => {
    const routes: Array<{ method: 'get' | 'post' | 'put'; path: string; body?: unknown }> = [
        { method: 'get', path: '/v1/workflow-templates' },
        { method: 'post', path: '/v1/workflow-templates', body: { kind: 'onboarding', name: 'X' } },
        { method: 'get', path: '/v1/workflow-templates/7' },
        { method: 'put', path: '/v1/workflow-templates/7', body: { active: false } },
        { method: 'post', path: '/v1/employees/3/workflows', body: { kind: 'onboarding', startDate: '2025-01-10' } },
        { method: 'get', path: '/v1/employees/3/workflows' },
        { method: 'get', path: '/v1/workflows' },
        { method: 'get', path: '/v1/workflows/21' },
        { method: 'post', path: '/v1/workflow-tasks/55/block', body: { reason: 'x' } },
        { method: 'post', path: '/v1/workflow-tasks/55/skip', body: { reason: 'x' } }
    ];

    for (const r of routes) {
        it(`${r.method.toUpperCase()} ${r.path}`, async () => {
            const { app } = testApp(() => ({ rows: [TEMPLATE, WF, TASK_JOIN] }));
            const res = await request(app)
                [r.method](r.path)
                .set(ADMIN)
                .send(r.body ?? {});
            expect(res.status).toBe(403);
        });
    }

    it('admin is not an assignee on complete → 403', async () => {
        const { app } = testApp((text) => {
            if (text.includes('FOR UPDATE OF t, w')) return { rows: [TASK_JOIN] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/workflow-tasks/55/complete').set(ADMIN).send({});
        expect(res.status).toBe(403);
    });

    it('missing credentials → 401', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/workflows');
        expect(res.status).toBe(401);
    });
});
