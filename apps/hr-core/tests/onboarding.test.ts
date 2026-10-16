// Onboarding/offboarding endpoint tests — stubbed pool, no live DB.
// The stub records every statement (incl. BEGIN/COMMIT/ROLLBACK) so tests can
// assert both HTTP semantics and the transactional SQL flow.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { ADMIN, HR, testApp, type SqlHandler } from './helpers.js';

const EMP_ACTIVE = {
    id: 3,
    user_id: null,
    employee_number: 'EMP-003',
    first_name: 'Luis',
    last_name: 'Paz',
    email: 'luis@strafor.local',
    status: 'active',
    currency: 'MXN',
    hire_date: '2024-01-10',
    termination_date: null
};

const EMP_TERMINATED = { ...EMP_ACTIVE, status: 'terminated', termination_date: '2024-06-01' };

const CASE_OPEN = {
    id: 5,
    employee_id: 3,
    type: 'offboarding',
    status: 'open',
    started_by: 2,
    due_date: null,
    created_at: '2024-05-01T00:00:00Z',
    updated_at: '2024-05-01T00:00:00Z'
};

const TASK_JOIN = {
    id: 9,
    case_id: 5,
    title: 'Sign contract',
    department: 'HR',
    owner_user_id: null,
    status: 'in_progress',
    due_date: null,
    completed_at: null,
    blocking: true,
    notes: null,
    created_at: '2024-05-01T00:00:00Z',
    case_type: 'onboarding',
    case_status: 'in_progress',
    employee_id: 3
};

describe('POST /v1/onboarding', () => {
    it('creates a case + template task list inside one transaction', async () => {
        const { app, stub } = testApp((text, params) => {
            if (text.startsWith('SELECT id FROM employees')) return { rows: [{ id: 3 }] };
            if (text.includes('INSERT INTO onboarding_cases')) return { rows: [CASE_OPEN] };
            if (text.includes('INSERT INTO onboarding_tasks')) {
                return {
                    rows: [
                        {
                            id: stub_seq(),
                            case_id: 5,
                            title: params[1],
                            department: params[2],
                            owner_user_id: params[3],
                            status: 'pending',
                            due_date: params[4],
                            completed_at: null,
                            blocking: params[5],
                            notes: params[6],
                            created_at: '2024-05-01T00:00:00Z'
                        }
                    ]
                };
            }
            return { rows: [] };
        });
        const res = await request(app).post('/v1/onboarding').set(HR).send({ employeeId: 3, type: 'offboarding' });
        expect(res.status).toBe(201);
        expect(res.body.type).toBe('offboarding');
        expect(res.body.status).toBe('open');
        expect(res.body.tasks.length).toBe(5); // built-in offboarding template
        expect(res.body.tasks.every((t: { status: string }) => t.status === 'pending')).toBe(true);
        const sql = stub.queryTexts();
        expect(sql[0]).toBe('BEGIN');
        expect(sql.at(-1)).toBe('COMMIT');
        expect(sql.filter((t) => t.includes('INSERT INTO onboarding_tasks'))).toHaveLength(5);
    });

    it('uses the task list from the request body when provided', async () => {
        const { app } = testApp((text, params) => {
            if (text.startsWith('SELECT id FROM employees')) return { rows: [{ id: 3 }] };
            if (text.includes('INSERT INTO onboarding_cases')) return { rows: [CASE_OPEN] };
            if (text.includes('INSERT INTO onboarding_tasks')) {
                return {
                    rows: [
                        {
                            id: 1,
                            case_id: 5,
                            title: params[1],
                            department: params[2],
                            owner_user_id: params[3],
                            status: 'pending',
                            due_date: null,
                            completed_at: null,
                            blocking: params[5],
                            notes: null,
                            created_at: 'x'
                        }
                    ]
                };
            }
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/onboarding')
            .set(HR)
            .send({
                employeeId: 3,
                type: 'onboarding',
                tasks: [{ title: 'Custom task', department: 'IT', blocking: true }]
            });
        expect(res.status).toBe(201);
        expect(res.body.tasks).toHaveLength(1);
        expect(res.body.tasks[0].title).toBe('Custom task');
        expect(res.body.tasks[0].blocking).toBe(true);
    });

    it('404 when the employee does not exist', async () => {
        const { app } = testApp(() => ({ rows: [] }));
        const res = await request(app).post('/v1/onboarding').set(HR).send({ employeeId: 999 });
        expect(res.status).toBe(404);
    });

    it('admin is rejected with 403', async () => {
        const { app, stub } = testApp();
        const res = await request(app).post('/v1/onboarding').set(ADMIN).send({ employeeId: 3 });
        expect(res.status).toBe(403);
        expect(stub.calls).toHaveLength(0);
    });
});

describe('PUT /v1/onboarding/:id — manual completion gates', () => {
    const openCaseHandler =
        (type: string): SqlHandler =>
        (text) => {
            if (text.includes('FOR UPDATE')) return { rows: [{ ...CASE_OPEN, type, status: 'in_progress' }] };
            if (text.includes('pending_all')) {
                return { rows: [{ pending_all: 3, pending_blocking: 1, blocked_count: 0 }] };
            }
            return { rows: [] };
        };

    it('offboarding cannot complete while blocking tasks are pending → 409', async () => {
        const { app, stub } = testApp(openCaseHandler('offboarding'));
        const res = await request(app).put('/v1/onboarding/5').set(HR).send({ status: 'completed' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/blocking tasks/i);
        expect(stub.queryTexts()).toContain('ROLLBACK');
        expect(stub.queryTexts().some((t) => t.includes('UPDATE employees'))).toBe(false);
    });

    it('onboarding cannot complete while any task is pending → 409', async () => {
        const { app } = testApp(openCaseHandler('onboarding'));
        const res = await request(app).put('/v1/onboarding/5').set(HR).send({ status: 'completed' });
        expect(res.status).toBe(409);
    });

    it('offboarding completes manually once blocking tasks are done (non-blocking may remain)', async () => {
        const { app, publisher } = testApp((text) => {
            if (text.includes('FOR UPDATE')) return { rows: [{ ...CASE_OPEN, status: 'in_progress' }] };
            if (text.includes('pending_all')) {
                return { rows: [{ pending_all: 2, pending_blocking: 0, blocked_count: 0 }] };
            }
            if (text.startsWith('UPDATE employees')) return { rows: [EMP_TERMINATED] };
            if (text.startsWith('SELECT * FROM onboarding_cases')) {
                return { rows: [{ ...CASE_OPEN, status: 'completed' }] };
            }
            if (text.startsWith('SELECT * FROM onboarding_tasks')) return { rows: [] };
            return { rows: [] };
        });
        const res = await request(app).put('/v1/onboarding/5').set(HR).send({ status: 'completed' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('completed');
        expect(publisher.published[0]?.type).toBe('strafor.hr.employee_terminated');
        expect(publisher.published[0]?.payload).toMatchObject({ employeeId: 3, reason: 'offboarding' });
    });
});

describe('PUT /v1/onboarding/tasks/:taskId — task-driven case rollup', () => {
    const taskFlow =
        (counts: { pending_all: number; pending_blocking: number; blocked_count: number }): SqlHandler =>
        (text) => {
            if (text.includes('JOIN onboarding_cases')) return { rows: [TASK_JOIN] };
            if (text.includes('pending_all')) return { rows: [counts] };
            if (text.startsWith('UPDATE employees')) return { rows: [EMP_ACTIVE] };
            if (text.startsWith('SELECT * FROM onboarding_tasks')) {
                return { rows: [{ ...TASK_JOIN, status: 'done', completed_at: '2024-05-02T00:00:00Z' }] };
            }
            if (text.startsWith('SELECT * FROM onboarding_cases')) {
                return {
                    rows: [
                        {
                            ...CASE_OPEN,
                            type: TASK_JOIN.case_type,
                            status: counts.pending_all === 0 ? 'completed' : 'in_progress'
                        }
                    ]
                };
            }
            return { rows: [] };
        };

    it('completing the last task completes the case and flips the employee to active', async () => {
        const { app, stub, publisher } = testApp(taskFlow({ pending_all: 0, pending_blocking: 0, blocked_count: 0 }));
        const res = await request(app).put('/v1/onboarding/tasks/9').set(HR).send({ status: 'done' });
        expect(res.status).toBe(200);
        expect(res.body.task.status).toBe('done');
        expect(res.body.case.status).toBe('completed');
        const sql = stub.queryTexts();
        expect(sql.some((t) => t.includes('UPDATE employees') && t.includes("'active'"))).toBe(true);
        const caseUpdate = stub.calls.find((c) => c.text.includes('UPDATE onboarding_cases'))!;
        expect(caseUpdate.params).toEqual([5, 'completed']);
        expect(publisher.published).toEqual([
            {
                type: 'strafor.hr.employee_updated',
                payload: expect.objectContaining({ employeeId: 3, status: 'active', changedFields: ['status'] })
            }
        ]);
    });

    it('offboarding completes when all blocking tasks are done (non-blocking may remain)', async () => {
        const { app, stub, publisher } = testApp((text) => {
            if (text.includes('JOIN onboarding_cases')) {
                return { rows: [{ ...TASK_JOIN, case_type: 'offboarding' }] };
            }
            if (text.includes('pending_all')) {
                return { rows: [{ pending_all: 2, pending_blocking: 0, blocked_count: 0 }] };
            }
            if (text.startsWith('UPDATE employees')) return { rows: [EMP_TERMINATED] };
            if (text.startsWith('SELECT * FROM onboarding_tasks')) {
                return { rows: [{ ...TASK_JOIN, status: 'done' }] };
            }
            if (text.startsWith('SELECT * FROM onboarding_cases')) {
                return { rows: [{ ...CASE_OPEN, status: 'completed' }] };
            }
            return { rows: [] };
        });
        const res = await request(app).put('/v1/onboarding/tasks/9').set(HR).send({ status: 'done' });
        expect(res.status).toBe(200);
        expect(res.body.case.status).toBe('completed');
        // The OFFBOARDING transition must run — a regression here previously
        // flipped the employee to 'active' via the onboarding branch.
        expect(stub.queryTexts().some((t) => t.includes('UPDATE employees') && t.includes("'terminated'"))).toBe(true);
        expect(publisher.published[0]?.type).toBe('strafor.hr.employee_terminated');
        expect(publisher.published[0]?.payload.status).toBe('terminated');
    });

    it('offboarding stays in progress while blocking tasks are pending', async () => {
        const { app, publisher } = testApp((text) => {
            if (text.includes('JOIN onboarding_cases')) {
                return { rows: [{ ...TASK_JOIN, case_type: 'offboarding', blocking: false }] };
            }
            if (text.includes('pending_all')) {
                return { rows: [{ pending_all: 2, pending_blocking: 1, blocked_count: 0 }] };
            }
            if (text.startsWith('SELECT * FROM onboarding_tasks')) {
                return { rows: [{ ...TASK_JOIN, status: 'done' }] };
            }
            if (text.startsWith('SELECT * FROM onboarding_cases')) {
                return { rows: [{ ...CASE_OPEN, status: 'in_progress' }] };
            }
            return { rows: [] };
        });
        const res = await request(app).put('/v1/onboarding/tasks/9').set(HR).send({ status: 'done' });
        expect(res.status).toBe(200);
        expect(res.body.case.status).toBe('in_progress');
        expect(publisher.published).toHaveLength(0);
    });

    it('tasks of a completed case are immutable → 409', async () => {
        const { app } = testApp((text) => {
            if (text.includes('JOIN onboarding_cases')) {
                return { rows: [{ ...TASK_JOIN, case_status: 'completed' }] };
            }
            return { rows: [] };
        });
        const res = await request(app).put('/v1/onboarding/tasks/9').set(HR).send({ status: 'done' });
        expect(res.status).toBe(409);
    });
});

describe('GET /v1/org/tree', () => {
    it('returns departments nested by parent_department_id', async () => {
        const { app } = testApp(() => ({
            rows: [
                { id: 1, name: 'Company', parent_department_id: null, status: 'active', employee_count: 10 },
                { id: 2, name: 'Engineering', parent_department_id: 1, status: 'active', employee_count: 6 },
                { id: 3, name: 'HR', parent_department_id: 1, status: 'active', employee_count: 4 }
            ]
        }));
        const res = await request(app).get('/v1/org/tree').set(HR);
        expect(res.status).toBe(200);
        expect(res.body.departments).toHaveLength(1);
        expect(res.body.departments[0].name).toBe('Company');
        expect(res.body.departments[0].children.map((c: { name: string }) => c.name)).toEqual(['Engineering', 'HR']);
    });
});

// Small helper so the POST test can fabricate increasing task ids.
let seq = 0;
function stub_seq() {
    seq += 1;
    return seq;
}
