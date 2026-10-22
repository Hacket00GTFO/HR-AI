// Viaticos tests: server-computed totals, draft-only editing, the
// draft→submitted→approved/rejected→paid state machine and its events.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { EMP_A, EMPLOYEE_ID_A, HR, testApp } from './helpers.js';
import { computeTotal } from '../src/routes/expenses.js';

const REPORT = {
    id: 9,
    employee_id: EMPLOYEE_ID_A,
    title: 'Trip to Monterrey',
    status: 'draft',
    currency: 'MXN',
    total: '150.00',
    submitted_at: null,
    decided_at: null,
    paid_at: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
};

describe('server-computed totals', () => {
    it('computeTotal sums item amounts (rounded to cents)', () => {
        expect(
            computeTotal([
                { date: '2025-01-01', category: 'transport', amount: 100.5 },
                { date: '2025-01-02', category: 'meals', amount: 49.5 }
            ])
        ).toBe(150);
        expect(computeTotal([])).toBe(0);
    });

    it('POST /v1/expenses/my stores the computed total, never a client one', async () => {
        const { app, stub } = testApp((text) => {
            if (text.includes('INSERT INTO expense_reports')) return { rows: [REPORT] };
            if (text.includes('FROM expense_reports')) return { rows: [REPORT] };
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/expenses/my')
            .set(EMP_A)
            .send({
                title: 'Trip to Monterrey',
                total: 999999, // ignored — the server recomputes from items
                items: [
                    { date: '2025-01-01', category: 'transport', amount: 100.5 },
                    { date: '2025-01-02', category: 'meals', amount: 49.5 }
                ]
            });
        // strict schema rejects the rogue `total` key outright.
        expect(res.status).toBe(400);
        expect(stub.calls.find((c) => c.text.includes('INSERT INTO expense_reports'))).toBeUndefined();
    });

    it('the INSERT carries sum(items) as the total parameter', async () => {
        const { app, stub } = testApp((text) => {
            if (text.includes('INSERT INTO expense_reports')) return { rows: [REPORT] };
            if (text.includes('FROM expense_reports')) return { rows: [REPORT] };
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/expenses/my')
            .set(EMP_A)
            .send({
                title: 'Trip to Monterrey',
                items: [
                    { date: '2025-01-01', category: 'transport', amount: 100.5 },
                    { date: '2025-01-02', category: 'meals', amount: 49.5 }
                ]
            });
        expect(res.status).toBe(201);
        const insert = stub.calls.find((c) => c.text.includes('INSERT INTO expense_reports'))!;
        expect(insert.params).toEqual([EMPLOYEE_ID_A, 'Trip to Monterrey', 'MXN', 150]);
        expect(res.body.total).toBe(150);
    });
});

describe('state machine', () => {
    it('submit moves draft→submitted and publishes expense_submitted', async () => {
        const { app, publisher } = testApp((text) => {
            if (text.includes('SELECT * FROM expense_reports')) return { rows: [REPORT] };
            if (text.includes('FROM expense_items WHERE report_id')) return { rows: [{ n: 2 }] };
            if (text.includes('UPDATE expense_reports')) return { rows: [{ ...REPORT, status: 'submitted' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/expenses/my/9/submit').set(EMP_A);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('submitted');
        expect(publisher.published.map((e) => e.type)).toContain('strafor.services.expense_submitted');
        expect(publisher.published[0]!.payload).toMatchObject({
            reportId: 9,
            employeeId: EMPLOYEE_ID_A,
            currency: 'MXN'
        });
    });

    it('submit on an empty report is a 409', async () => {
        const { app } = testApp((text) => {
            if (text.includes('SELECT * FROM expense_reports')) return { rows: [REPORT] };
            if (text.includes('FROM expense_items WHERE report_id')) return { rows: [{ n: 0 }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/expenses/my/9/submit').set(EMP_A);
        expect(res.status).toBe(409);
    });

    it('submit on a non-draft report is a 409', async () => {
        const { app } = testApp((text) => {
            if (text.includes('SELECT * FROM expense_reports')) return { rows: [{ ...REPORT, status: 'submitted' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/expenses/my/9/submit').set(EMP_A);
        expect(res.status).toBe(409);
    });

    it('decide on a draft report is a 409 (only submitted can be decided)', async () => {
        const { app, stub } = testApp((text) => {
            if (text.includes('SELECT * FROM expense_reports')) return { rows: [REPORT] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/expenses/9/decide').set(HR).send({ decision: 'approved' });
        expect(res.status).toBe(409);
        expect(stub.calls.find((c) => c.text.includes('INSERT INTO expense_approvals'))).toBeUndefined();
    });

    it('decide on a submitted report approves and publishes expense_decided', async () => {
        const { app, publisher, stub } = testApp((text) => {
            if (text.includes('SELECT * FROM expense_reports')) {
                return { rows: [{ ...REPORT, status: 'submitted' }] };
            }
            if (text.includes('UPDATE expense_reports')) return { rows: [{ ...REPORT, status: 'approved' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/expenses/9/decide').set(HR).send({ decision: 'approved' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('approved');
        expect(stub.calls.find((c) => c.text.includes('INSERT INTO expense_approvals'))).toBeDefined();
        expect(publisher.published.map((e) => e.type)).toContain('strafor.services.expense_decided');
    });

    it('pay requires approved — a submitted report gets 409', async () => {
        const { app } = testApp((text) => {
            if (text.includes('UPDATE expense_reports')) return { rows: [] };
            if (text.includes('SELECT status FROM expense_reports')) return { rows: [{ status: 'submitted' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/expenses/9/pay').set(HR);
        expect(res.status).toBe(409);
    });
});

describe('employee self-scope', () => {
    it('another employee cannot read the report (scoped query → 404)', async () => {
        const { app, stub } = testApp(() => ({ rows: [] }));
        const res = await request(app).get('/v1/expenses/my/9').set(EMP_A);
        expect(res.status).toBe(404);
        const q = stub.calls.find((c) => c.text.includes('FROM expense_reports'))!;
        expect(q.text).toContain('r.employee_id = $2');
        expect(q.params).toEqual([9, EMPLOYEE_ID_A]);
    });
});
