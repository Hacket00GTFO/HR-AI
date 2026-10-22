// Assets tests: checkout/checkin state machine with condition notes,
// employee self-scoped assignment reads, and outbox events.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { EMP_A, EMPLOYEE_ID_A, HR, testApp } from './helpers.js';

const ASSET = {
    id: 3,
    tag: 'STR-LAP-003',
    type: 'laptop',
    serial: 'SN123',
    description: 'MacBook Pro',
    status: 'available',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
};

const ASSIGNMENT = {
    id: 11,
    asset_id: 3,
    employee_id: EMPLOYEE_ID_A,
    assigned_at: '2025-01-01T00:00:00Z',
    returned_at: null,
    condition_out: 'good',
    condition_in: null,
    assigned_by: 2,
    returned_by: null
};

describe('checkout / checkin', () => {
    it('checkout assigns an available asset and publishes asset_assigned', async () => {
        const { app, publisher, stub } = testApp((text) => {
            if (text.includes('SELECT * FROM assets')) return { rows: [ASSET] };
            if (text.includes('INSERT INTO asset_assignments')) return { rows: [ASSIGNMENT] };
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/assets/3/checkout')
            .set(HR)
            .send({ employeeId: EMPLOYEE_ID_A, conditionOut: 'good' });
        expect(res.status).toBe(201);
        expect(res.body.employeeId).toBe(EMPLOYEE_ID_A);
        expect(stub.calls.find((c) => c.text.includes(`SET status = 'assigned'`))).toBeDefined();
        expect(publisher.published.map((e) => e.type)).toContain('strafor.services.asset_assigned');
    });

    it('checkout on a non-available asset is a 409', async () => {
        const { app } = testApp((text) => {
            if (text.includes('SELECT * FROM assets')) return { rows: [{ ...ASSET, status: 'assigned' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/assets/3/checkout').set(HR).send({ employeeId: EMPLOYEE_ID_A });
        expect(res.status).toBe(409);
    });

    it('checkin closes the open assignment and publishes asset_returned', async () => {
        const { app, publisher, stub } = testApp((text) => {
            if (text.includes('SELECT * FROM assets')) return { rows: [{ ...ASSET, status: 'assigned' }] };
            if (text.includes('UPDATE asset_assignments')) {
                return { rows: [{ ...ASSIGNMENT, returned_at: '2025-02-01T00:00:00Z', condition_in: 'worn' }] };
            }
            return { rows: [] };
        });
        const res = await request(app)
            .post('/v1/assets/3/checkin')
            .set(HR)
            .send({ conditionIn: 'worn', status: 'maintenance' });
        expect(res.status).toBe(200);
        expect(res.body.returnedAt).toBe('2025-02-01T00:00:00Z');
        expect(stub.calls.find((c) => c.text.includes('UPDATE assets SET status'))?.params).toEqual([3, 'maintenance']);
        const ev = publisher.published.find((e) => e.type === 'strafor.services.asset_returned');
        expect(ev?.payload).toMatchObject({ assetId: 3, employeeId: EMPLOYEE_ID_A, assetStatus: 'maintenance' });
    });

    it('checkin on an asset without an open assignment is a 409', async () => {
        const { app } = testApp((text) => {
            if (text.includes('SELECT * FROM assets')) return { rows: [ASSET] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/assets/3/checkin').set(HR).send({});
        expect(res.status).toBe(409); // available, not assigned
    });
});

describe('employee self-scope', () => {
    it('GET /v1/assets/my is scoped to the caller employee_id', async () => {
        const { app, stub } = testApp(() => ({ rows: [] }));
        const res = await request(app).get('/v1/assets/my').set(EMP_A);
        expect(res.status).toBe(200);
        const q = stub.calls.find((c) => c.text.includes('FROM asset_assignments'))!;
        expect(q.text).toContain('a.employee_id = $1');
        expect(q.params).toEqual([EMPLOYEE_ID_A]);
    });
});
