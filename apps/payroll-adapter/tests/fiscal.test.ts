// Fiscal endpoints: hr-only access, audited reads/writes, provider CRUD.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN, HR, testApp, type SqlHandler } from './helpers.js';

const FISCAL_ROW = {
    id: 1,
    employee_id: 7,
    rfc: 'LOLA900101ABC',
    curp: 'LOLA900101MDFPNS01',
    nss: '12345678901',
    clabe: '012345678901234567',
    bank_code: '012',
    legal_entity: 'Strafor MX',
    regime: 'sueldos',
    contract_type: 'indefinite',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
};

const auditsFor = (stub: { calls: Array<{ text: string; params: unknown[] }> }, action: string) =>
    stub.calls.filter((c) => c.text.includes('INSERT INTO payroll_audit') && c.params[1] === action);

describe('GET /v1/payroll/fiscal/:employeeId', () => {
    it('returns the fiscal record and audits the read', async () => {
        const { app, stub } = testApp((text) =>
            text.includes('FROM employee_fiscal_mx') ? { rows: [FISCAL_ROW] } : { rows: [] }
        );
        const res = await request(app).get('/v1/payroll/fiscal/7').set(HR);
        expect(res.status).toBe(200);
        expect(res.body.rfc).toBe('LOLA900101ABC');
        expect(res.body.clabe).toBe('012345678901234567');
        const audit = auditsFor(stub, 'fiscal.read');
        expect(audit).toHaveLength(1);
        expect(audit[0]!.params[0]).toBe('user:2');
        expect(audit[0]!.params[3]).toBe('7');
    });

    it('audits the read attempt even on a miss (404)', async () => {
        const { app, stub } = testApp(() => ({ rows: [] }));
        const res = await request(app).get('/v1/payroll/fiscal/7').set(HR);
        expect(res.status).toBe(404);
        expect(auditsFor(stub, 'fiscal.read')).toHaveLength(1);
    });

    it('admin → 403 with no SQL and no audit row', async () => {
        const { app, stub } = testApp();
        const res = await request(app).get('/v1/payroll/fiscal/7').set(ADMIN);
        expect(res.status).toBe(403);
        expect(stub.calls).toHaveLength(0);
    });
});

describe('PUT /v1/payroll/fiscal/:employeeId', () => {
    it('upserts on employee_id and audits the write', async () => {
        const handler: SqlHandler = (text) =>
            text.includes('INSERT INTO employee_fiscal_mx') ? { rows: [FISCAL_ROW] } : { rows: [] };
        const { app, stub } = testApp(handler);
        const res = await request(app)
            .put('/v1/payroll/fiscal/7')
            .set(HR)
            .send({ rfc: 'LOLA900101ABC', clabe: '012345678901234567', bankCode: '012' });
        expect(res.status).toBe(200);
        const upsert = stub.calls.find((c) => c.text.includes('INSERT INTO employee_fiscal_mx'))!;
        expect(upsert.text).toContain('ON CONFLICT (employee_id) DO UPDATE');
        expect(upsert.params).toEqual([7, 'LOLA900101ABC', '012345678901234567', '012']);
        expect(auditsFor(stub, 'fiscal.upsert')).toHaveLength(1);
    });

    it('rejects an empty body', async () => {
        const { app, stub } = testApp();
        const res = await request(app).put('/v1/payroll/fiscal/7').set(HR).send({});
        expect(res.status).toBe(400);
        expect(stub.calls).toHaveLength(0);
    });

    it('rejects unknown keys (strict schema)', async () => {
        const { app, stub } = testApp();
        const res = await request(app)
            .put('/v1/payroll/fiscal/7')
            .set(HR)
            .send({ rfc: 'LOLA900101ABC', isAdmin: true });
        expect(res.status).toBe(400);
        expect(stub.calls).toHaveLength(0);
    });
});

describe('/v1/payroll/providers', () => {
    const PROVIDER = {
        id: 1,
        name: 'file_generic',
        adapter: 'file_generic',
        config: {},
        enabled: true,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z'
    };

    it('GET lists providers', async () => {
        const { app } = testApp((text) =>
            text.includes('FROM payroll_providers') ? { rows: [PROVIDER] } : { rows: [] }
        );
        const res = await request(app).get('/v1/payroll/providers').set(HR);
        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({ name: 'file_generic', adapter: 'file_generic', enabled: true });
    });

    it('PUT enables/disables and updates config with adapter validation', async () => {
        const handler: SqlHandler = (text) => {
            if (text.includes('UPDATE payroll_providers')) {
                return { rows: [{ ...PROVIDER, enabled: false }] };
            }
            if (text.includes('FROM payroll_providers')) return { rows: [PROVIDER] };
            return { rows: [] };
        };
        const { app, stub } = testApp(handler);
        const res = await request(app)
            .put('/v1/payroll/providers/1')
            .set(HR)
            .send({ enabled: false, config: { file: 'acme-jan.json' } });
        expect(res.status).toBe(200);
        const upd = stub.calls.find((c) => c.text.includes('UPDATE payroll_providers'))!;
        expect(upd.params).toEqual([1, false, '{"file":"acme-jan.json"}']);
        expect(auditsFor(stub, 'provider.update')).toHaveLength(1);
    });

    it('PUT 404s on unknown provider', async () => {
        const { app } = testApp(() => ({ rows: [] }));
        const res = await request(app).put('/v1/payroll/providers/99').set(HR).send({ enabled: true });
        expect(res.status).toBe(404);
    });
});
