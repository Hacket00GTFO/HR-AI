// POST /v1/payroll/periods/:id/dispersion — CLABE-interbancaria bank file.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { DISPERSION_DETAIL_LEN, DISPERSION_HEADER_LEN, DISPERSION_TRAILER_LEN } from '../src/formats.js';
import { HR, PERIOD, recordingPublisher, silentLog, stubPool, testConfig, type SqlHandler } from './helpers.js';

const CLABE_A = '012345678901234568'; // valid mod-10 checksum
const CLABE_B = '111111111111111115'; // valid mod-10 checksum

const EXPORT_ROW = {
    id: 11,
    period_id: 5,
    kind: 'dispersion',
    format: 'txt',
    storage_ref: 'x',
    generated_by: 2,
    generated_at: '2025-01-31T00:00:00Z'
};

const handler =
    (
        status = 'exported',
        items?: Array<Record<string, unknown>>,
        provider?: Record<string, unknown> | null
    ): SqlHandler =>
    (text) => {
        if (text.includes('FROM payroll_periods WHERE id')) {
            return { rows: [{ ...PERIOD, status }] };
        }
        if (text.includes('FROM payroll_providers')) {
            return {
                rows:
                    provider === null
                        ? []
                        : [
                              provider ?? {
                                  id: 4,
                                  name: 'banco',
                                  adapter: 'bank_dispersion',
                                  config: { rfc: 'BANX010101ABC' },
                                  enabled: true
                              }
                          ]
            };
        }
        if (text.includes('FROM payroll_items')) {
            return {
                rows: items ?? [
                    { employee_id: 7, net: '12080.00', provider_ref: 'p-7', clabe: CLABE_A, bank_name: 'BBVA' },
                    { employee_id: 8, net: '99.50', provider_ref: 'p-8', clabe: CLABE_B, bank_name: 'Santander' }
                ]
            };
        }
        if (text.includes('INSERT INTO payroll_exports')) {
            return { rows: [EXPORT_ROW] };
        }
        return { rows: [] };
    };

function dispersionApp(h: SqlHandler) {
    const config = testConfig();
    const stub = stubPool(h);
    const app = createApp({ pool: stub.pool, config, publisher: recordingPublisher(), log: silentLog });
    return { app, stub, config };
}

describe('POST /v1/payroll/periods/:id/dispersion', () => {
    it('generates the dispersion file, registers the export and audits', async () => {
        const { app, stub, config } = dispersionApp(handler('exported'));
        const res = await request(app).post('/v1/payroll/periods/5/dispersion').set(HR).send({});
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            periodId: 5,
            kind: 'dispersion',
            format: 'txt',
            count: 2,
            totalCents: 1208000 + 9950
        });

        // File on disk: header + 2 details + trailer with correct lengths/totals.
        const file = path.join(config.EXPORTS_DIR, 'dispersion-5.txt');
        expect(existsSync(file)).toBe(true);
        const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
        expect(lines).toHaveLength(4);
        expect(lines[0]).toHaveLength(DISPERSION_HEADER_LEN);
        expect(lines[0]!.startsWith('01BANX010101ABC')).toBe(true); // RFC from provider config
        expect(lines[0]!.slice(23, 29)).toBe('000002');
        expect(lines[0]!.slice(29, 44)).toBe('000000001217950');
        expect(lines[1]).toHaveLength(DISPERSION_DETAIL_LEN);
        expect(lines[1]!.slice(2, 20)).toBe(CLABE_A);
        expect(lines[1]!.slice(20, 35)).toBe('000000001208000');
        expect(lines[3]).toHaveLength(DISPERSION_TRAILER_LEN);
        expect(lines[3]).toBe('03000002000000001217950');

        // payroll_exports row with kind 'dispersion'.
        const exportInsert = stub.calls.find((c) => c.text.includes('INSERT INTO payroll_exports'))!;
        expect(exportInsert.text).toContain("'dispersion'");
        expect(exportInsert.params[0]).toBe(5);

        // Audit: aggregate metadata only — no employee-level PII.
        const audit = stub.calls.find(
            (c) => c.text.includes('INSERT INTO payroll_audit') && c.params[1] === 'dispersion_export'
        )!;
        const metadata = JSON.parse(String(audit.params[4]));
        expect(metadata).toEqual({ count: 2, totalCents: 1217950, file: 'dispersion-5.txt' });
    });

    it('uses the placeholder RFC when no bank_dispersion provider exists', async () => {
        const { app, config } = dispersionApp(handler('exported', undefined, null));
        const res = await request(app).post('/v1/payroll/periods/5/dispersion').set(HR).send({});
        expect(res.status).toBe(201);
        const header = readFileSync(path.join(config.EXPORTS_DIR, 'dispersion-5.txt'), 'utf8').split('\n')[0]!;
        expect(header.slice(2, 15)).toBe('XAXX010101000');
    });

    it('409 when the period is not exported/reconciled (locked)', async () => {
        const { app, config } = dispersionApp(handler('locked'));
        const res = await request(app).post('/v1/payroll/periods/5/dispersion').set(HR).send({});
        expect(res.status).toBe(409);
        expect(existsSync(path.join(config.EXPORTS_DIR, 'dispersion-5.txt'))).toBe(false);
    });

    it('409 on draft; 201 on reconciled', async () => {
        const draft = dispersionApp(handler('draft'));
        expect((await request(draft.app).post('/v1/payroll/periods/5/dispersion').set(HR).send({})).status).toBe(409);
        const ok = dispersionApp(handler('reconciled'));
        expect((await request(ok.app).post('/v1/payroll/periods/5/dispersion').set(HR).send({})).status).toBe(201);
    });

    it('422 when an item has a missing or invalid CLABE', async () => {
        const { app } = dispersionApp(
            handler('exported', [
                { employee_id: 7, net: '12080.00', provider_ref: 'p-7', clabe: '012345678901234567' }, // bad checksum
                { employee_id: 8, net: '99.50', provider_ref: 'p-8', clabe: null }
            ])
        );
        const res = await request(app).post('/v1/payroll/periods/5/dispersion').set(HR).send({});
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/CLABE/);
    });

    it('422 when a named provider is not found/disabled', async () => {
        const { app } = dispersionApp(handler('exported', undefined, null));
        const res = await request(app)
            .post('/v1/payroll/periods/5/dispersion')
            .set(HR)
            .send({ provider: 'nonexistent' });
        expect(res.status).toBe(422);
    });

    it('422 when the period has no items', async () => {
        const { app } = dispersionApp(handler('exported', []));
        const res = await request(app).post('/v1/payroll/periods/5/dispersion').set(HR).send({});
        expect(res.status).toBe(422);
    });
});
