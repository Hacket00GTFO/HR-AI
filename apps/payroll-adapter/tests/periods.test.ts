// Period endpoints: CRUD-lite, lifecycle transitions, four-eyes, RBAC.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN, HR, HR_OTHER, PERIOD, SERVICE, testApp, type SqlHandler } from './helpers.js';

const auditInserts = (stub: { calls: Array<{ text: string; params: unknown[] }> }) =>
    stub.calls.filter((c) => c.text.includes('INSERT INTO payroll_audit'));

describe('POST /v1/payroll/periods', () => {
    it('creates a draft period and audits the mutation', async () => {
        const { app, stub } = testApp((text) => {
            if (text.includes('INSERT INTO payroll_periods')) return { rows: [PERIOD] };
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/payroll/periods')
            .set(HR)
            .send({ frequency: 'catorcenal', periodStart: '2025-01-01', periodEnd: '2025-01-14' });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('draft');
        expect(res.body.frequency).toBe('catorcenal');
        const insert = stub.calls.find((c) => c.text.includes('INSERT INTO payroll_periods'))!;
        expect(insert.params).toContain('catorcenal');
        expect(insert.params).toContain(2); // created_by = calling user
        expect(auditInserts(stub)).toHaveLength(1);
        expect(auditInserts(stub)[0]!.params[1]).toBe('period.create');
    });

    it('rejects invalid frequency', async () => {
        const { app, stub } = testApp();
        const res = await request(app)
            .post('/v1/payroll/periods')
            .set(HR)
            .send({ frequency: 'weekly', periodStart: '2025-01-01', periodEnd: '2025-01-07' });
        expect(res.status).toBe(400);
        expect(stub.calls).toHaveLength(0);
    });

    it('rejects periodEnd before periodStart', async () => {
        const { app } = testApp();
        const res = await request(app)
            .post('/v1/payroll/periods')
            .set(HR)
            .send({ frequency: 'mensual', periodStart: '2025-02-01', periodEnd: '2025-01-01' });
        expect(res.status).toBe(400);
    });
});

describe('GET /v1/payroll/periods', () => {
    it('lists periods and applies allowlisted filters', async () => {
        const { app, stub } = testApp(() => ({ rows: [PERIOD] }));
        const res = await request(app).get('/v1/payroll/periods?status=draft&frequency=catorcenal').set(HR);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        const { text, params } = stub.calls.at(-1)!;
        expect(text).toContain('status = $1');
        expect(text).toContain('frequency = $2');
        expect(params).toEqual(['draft', 'catorcenal']);
    });

    it('rejects a bogus status filter', async () => {
        const { app, stub } = testApp();
        const res = await request(app).get('/v1/payroll/periods?status=hacked').set(HR);
        expect(res.status).toBe(400);
        expect(stub.calls).toHaveLength(0);
    });
});

describe('PUT /v1/payroll/periods/:id/status', () => {
    const handler =
        (from: string, createdBy = 2): SqlHandler =>
        (text) => {
            if (text.includes('FROM payroll_periods WHERE id')) {
                return { rows: [{ ...PERIOD, status: from, created_by: createdBy }] };
            }
            if (text.includes('UPDATE payroll_periods')) {
                return { rows: [{ ...PERIOD, status: 'locked', created_by: createdBy }] };
            }
            return { rows: [] };
        };

    it('draft → calculating succeeds, audits and publishes period_status', async () => {
        const { app, stub, publisher } = testApp(handler('draft'));
        const res = await request(app).put('/v1/payroll/periods/5/status').set(HR).send({ status: 'calculating' });
        expect(res.status).toBe(200);
        const upd = stub.calls.find((c) => c.text.includes('UPDATE payroll_periods'))!;
        expect(upd.params).toEqual([5, 'calculating', 'draft']);
        expect(upd.text).not.toContain('approved_by');
        expect(auditInserts(stub)[0]?.params[1]).toBe('period.status');
        expect(publisher.published).toEqual([
            {
                type: 'strafor.payroll.period_status',
                payload: expect.objectContaining({ periodId: 5, from: 'draft', to: 'calculating', actor: 'user:2' })
            }
        ]);
    });

    it('illegal transition draft → locked → 409', async () => {
        const { app, stub } = testApp(handler('draft'));
        const res = await request(app).put('/v1/payroll/periods/5/status').set(HR).send({ status: 'locked' });
        expect(res.status).toBe(409);
        expect(stub.calls.some((c) => c.text.includes('UPDATE payroll_periods'))).toBe(false);
    });

    it('cancelled is rejected from calculating (only draft/review)', async () => {
        const { app } = testApp(handler('calculating'));
        const res = await request(app).put('/v1/payroll/periods/5/status').set(HR).send({ status: 'cancelled' });
        expect(res.status).toBe(409);
    });

    it('four-eyes: locked → exported by the creator → 409', async () => {
        const { app, stub } = testApp(handler('locked', 2));
        const res = await request(app).put('/v1/payroll/periods/5/status').set(HR).send({ status: 'exported' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/different approver/);
        expect(stub.calls.some((c) => c.text.includes('UPDATE payroll_periods'))).toBe(false);
    });

    it('four-eyes: locked → exported by a different hr user → 200 + approved_by recorded', async () => {
        const { app, stub } = testApp(handler('locked', 2));
        const res = await request(app).put('/v1/payroll/periods/5/status').set(HR_OTHER).send({ status: 'exported' });
        expect(res.status).toBe(200);
        const upd = stub.calls.find((c) => c.text.includes('UPDATE payroll_periods'))!;
        expect(upd.text).toContain('approved_by = $4');
        expect(upd.params).toEqual([5, 'exported', 'locked', 9]);
    });

    it('four-eyes: reconciled → finalized by the creator → 409', async () => {
        const { app } = testApp(handler('reconciled', 2));
        const res = await request(app).put('/v1/payroll/periods/5/status').set(HR).send({ status: 'finalized' });
        expect(res.status).toBe(409);
    });

    it('pure service caller cannot satisfy four-eyes → 409', async () => {
        const { app } = testApp(handler('locked', 2));
        const res = await request(app).put('/v1/payroll/periods/5/status').set(SERVICE).send({ status: 'exported' });
        expect(res.status).toBe(409);
    });

    it('404 when period does not exist', async () => {
        const { app } = testApp(() => ({ rows: [] }));
        const res = await request(app).put('/v1/payroll/periods/5/status').set(HR).send({ status: 'calculating' });
        expect(res.status).toBe(404);
    });
});

describe('RBAC governance', () => {
    it('admin → 403 on every payroll route (before any SQL)', async () => {
        const { app, stub } = testApp();
        for (const [method, url] of [
            ['get', '/v1/payroll/periods'],
            ['post', '/v1/payroll/periods'],
            ['get', '/v1/payroll/periods/5'],
            ['put', '/v1/payroll/periods/5/status'],
            ['get', '/v1/payroll/periods/5/items'],
            ['post', '/v1/payroll/periods/5/import'],
            ['post', '/v1/payroll/periods/5/reconcile'],
            ['post', '/v1/payroll/periods/5/export'],
            ['post', '/v1/payroll/periods/5/dispersion'],
            ['get', '/v1/payroll/fiscal/7'],
            ['put', '/v1/payroll/fiscal/7'],
            ['get', '/v1/payroll/providers'],
            ['put', '/v1/payroll/providers/1']
        ] as const) {
            const res = await request(app)[method](url).set(ADMIN).send({});
            expect(res.status, `${method} ${url}`).toBe(403);
        }
        expect(stub.calls).toHaveLength(0);
    });

    it('missing credentials → 401', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/payroll/periods');
        expect(res.status).toBe(401);
    });

    it('non-hr user role → 403', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/payroll/periods').set({ 'X-User-Id': '3', 'X-User-Role': 'manager' });
        expect(res.status).toBe(403);
    });
});
