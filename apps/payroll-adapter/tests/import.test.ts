// Import endpoint: adapter resolution, item upsert idempotency, status gating.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { HR, PERIOD, SANDBOX_PROVIDER, testApp, type SqlHandler } from './helpers.js';

const importHandler =
    (status = 'calculating'): SqlHandler =>
    (text) => {
        if (text.includes('FROM payroll_periods WHERE id')) {
            return { rows: [{ ...PERIOD, status }] };
        }
        if (text.includes('FROM payroll_providers')) {
            return { rows: [SANDBOX_PROVIDER] };
        }
        if (text.includes('INSERT INTO payroll_items')) {
            return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
    };

const itemInserts = (stub: { calls: Array<{ text: string; params: unknown[] }> }) =>
    stub.calls.filter((c) => c.text.includes('INSERT INTO payroll_items'));

describe('POST /v1/payroll/periods/:id/import', () => {
    it('imports sandbox_stub results and upserts on (period_id, provider_ref)', async () => {
        const { app, stub } = testApp(importHandler());
        const res = await request(app).post('/v1/payroll/periods/5/import').set(HR).send({});
        expect(res.status).toBe(200);
        expect(res.body.provider).toBe('sandbox_stub');
        // sandbox config has employees [7, 8] → two upserts.
        const inserts = itemInserts(stub);
        expect(inserts).toHaveLength(2);
        expect(inserts[0]!.text).toContain('ON CONFLICT (period_id, provider_ref) DO UPDATE');
        expect(inserts[0]!.params[1]).toBe(7); // employee_id
        expect(inserts[0]!.params[6]).toBe('stub-5-7'); // provider_ref
        expect(inserts[1]!.params[6]).toBe('stub-5-8');
    });

    it('is idempotent — re-running import issues the same upserts (no dup rows)', async () => {
        const { app, stub } = testApp(importHandler());
        await request(app).post('/v1/payroll/periods/5/import').set(HR).send({});
        await request(app).post('/v1/payroll/periods/5/import').set(HR).send({});
        const inserts = itemInserts(stub);
        expect(inserts).toHaveLength(4); // 2 items × 2 runs, all upserts
        const refs = inserts.map((c) => c.params[6]);
        expect(new Set(refs).size).toBe(2); // only two distinct provider_refs
    });

    it('selects a named provider when body.provider is given', async () => {
        const { app, stub } = testApp(importHandler());
        const res = await request(app).post('/v1/payroll/periods/5/import').set(HR).send({ provider: 'sandbox_stub' });
        expect(res.status).toBe(200);
        const providerQuery = stub.calls.find((c) => c.text.includes('FROM payroll_providers'))!;
        expect(providerQuery.text).toContain('name = $1');
        expect(providerQuery.params).toEqual(['sandbox_stub']);
    });

    it('409 when the period is in a non-importable status (draft)', async () => {
        const { app, stub } = testApp(importHandler('draft'));
        const res = await request(app).post('/v1/payroll/periods/5/import').set(HR).send({});
        expect(res.status).toBe(409);
        expect(itemInserts(stub)).toHaveLength(0);
    });

    it('422 when no provider is enabled', async () => {
        const { app } = testApp((text) => {
            if (text.includes('FROM payroll_periods WHERE id')) {
                return { rows: [{ ...PERIOD, status: 'calculating' }] };
            }
            return { rows: [] }; // no provider
        });
        const res = await request(app).post('/v1/payroll/periods/5/import').set(HR).send({});
        expect(res.status).toBe(422);
    });

    it('audits the import', async () => {
        const { app, stub } = testApp(importHandler());
        await request(app).post('/v1/payroll/periods/5/import').set(HR).send({});
        const audit = stub.calls.find((c) => c.text.includes('INSERT INTO payroll_audit'));
        expect(audit?.params[1]).toBe('period.import');
        expect(audit?.params[0]).toBe('user:2');
    });
});
