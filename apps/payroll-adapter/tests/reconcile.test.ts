// Reconcile endpoint: shadow-mode delta detection + event emission.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { HR, PERIOD, testApp, type SqlHandler } from './helpers.js';

const handler =
    (status = 'review', items: Array<Record<string, unknown>> = []): SqlHandler =>
    (text) => {
        if (text.includes('FROM payroll_periods WHERE id')) {
            return { rows: [{ ...PERIOD, status }] };
        }
        if (text.includes('FROM payroll_items WHERE period_id')) {
            return { rows: items };
        }
        return { rows: [] };
    };

const reconInserts = (stub: { calls: Array<{ text: string; params: unknown[] }> }) =>
    stub.calls.filter((c) => c.text.includes('INSERT INTO payroll_reconciliations'));

describe('POST /v1/payroll/periods/:id/reconcile', () => {
    it('writes a reconciliation row only for deltas', async () => {
        const items = [
            { employee_id: 7, gross: '15100.00', net: '12080.00' },
            { employee_id: 8, gross: '15200.00', net: '12160.00' }
        ];
        const { app, stub, publisher } = testApp(handler('review', items));
        const res = await request(app)
            .post('/v1/payroll/periods/5/reconcile')
            .set(HR)
            .send({
                expectations: [
                    { employeeId: 7, field: 'gross', expected: 15100 }, // exact — no delta
                    { employeeId: 8, field: 'gross', expected: 15000 } // delta +200
                ]
            });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ periodId: 5, compared: 2, deltas: 1 });
        const rows = reconInserts(stub);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.params).toEqual([5, 8, 'gross', 15000, 15200, 200]);
        expect(publisher.published).toEqual([
            { type: 'strafor.payroll.reconciled', payload: { periodId: 5, compared: 2, deltas: 1 } }
        ]);
    });

    it('records a delta when the employee has no imported item (missing actual)', async () => {
        const { app, stub } = testApp(handler('review', []));
        const res = await request(app)
            .post('/v1/payroll/periods/5/reconcile')
            .set(HR)
            .send({ expectations: [{ employeeId: 7, field: 'net', expected: 12080 }] });
        expect(res.status).toBe(200);
        expect(res.body.deltas).toBe(1);
        const rows = reconInserts(stub);
        expect(rows[0]!.params).toEqual([5, 7, 'net', 12080, null, null]);
    });

    it('accepts the baseline map form', async () => {
        const items = [{ employee_id: 7, gross: '15100.00', net: '12080.00' }];
        const { app, stub } = testApp(handler('exported', items));
        const res = await request(app)
            .post('/v1/payroll/periods/5/reconcile')
            .set(HR)
            .send({ baseline: { '7': { gross: 15100, net: 11000 } } });
        expect(res.status).toBe(200);
        expect(res.body.compared).toBe(2);
        expect(res.body.deltas).toBe(1); // net delta: actual 12080 - expected 11000 = +1080
        const rows = reconInserts(stub);
        expect(rows[0]!.params[2]).toBe('net');
        expect(rows[0]!.params[5]).toBe(1080);
    });

    it('toleranceCents: diffs within tolerance are matched, beyond are deltas', async () => {
        const items = [
            { employee_id: 7, gross: '15100.01', net: '12080.00' }, // +1 cent vs 15100
            { employee_id: 8, gross: '15200.05', net: '12160.00' } // +5 cents vs 15200
        ];
        // Default tolerance (1 cent): emp7 matched, emp8 delta.
        const a = testApp(handler('review', items));
        let res = await request(a.app)
            .post('/v1/payroll/periods/5/reconcile')
            .set(HR)
            .send({
                expectations: [
                    { employeeId: 7, field: 'gross', expected: 15100 },
                    { employeeId: 8, field: 'gross', expected: 15200 }
                ]
            });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ compared: 2, deltas: 1, toleranceCents: 1 });
        let rows = reconInserts(a.stub);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.params).toEqual([5, 8, 'gross', 15200, 15200.05, 0.05]);

        // toleranceCents: 0 → any cent diff is a delta.
        const b = testApp(handler('review', items));
        res = await request(b.app)
            .post('/v1/payroll/periods/5/reconcile')
            .set(HR)
            .send({ toleranceCents: 0, expectations: [{ employeeId: 7, field: 'gross', expected: 15100 }] });
        expect(res.body.deltas).toBe(1);
        rows = reconInserts(b.stub);
        expect(rows[0]!.params[5]).toBe(0.01);

        // toleranceCents: 5 → the 5-cent diff is matched too.
        const c = testApp(handler('review', items));
        res = await request(c.app)
            .post('/v1/payroll/periods/5/reconcile')
            .set(HR)
            .send({ toleranceCents: 5, expectations: [{ employeeId: 8, field: 'gross', expected: 15200 }] });
        expect(res.body.deltas).toBe(0);
        expect(reconInserts(c.stub)).toHaveLength(0);
    });

    it('409 when period status does not allow reconciliation (draft)', async () => {
        const { app, stub } = testApp(handler('draft'));
        const res = await request(app)
            .post('/v1/payroll/periods/5/reconcile')
            .set(HR)
            .send({ expectations: [{ employeeId: 7, field: 'gross', expected: 1 }] });
        expect(res.status).toBe(409);
        expect(reconInserts(stub)).toHaveLength(0);
    });

    it('400 when neither expectations nor baseline is provided', async () => {
        const { app } = testApp(handler());
        const res = await request(app).post('/v1/payroll/periods/5/reconcile').set(HR).send({});
        expect(res.status).toBe(400);
    });
});
