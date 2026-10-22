// sua_file adapter: SUA movements parsing, NSS→employee resolution,
// unmatched handling, exportLayout rendering, and end-to-end import.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createSuaFileAdapter } from '../src/adapters/suaFile.js';
import { padLeft, padRight } from '../src/formats.js';
import { createApp } from '../src/app.js';
import { HR, PERIOD, recordingPublisher, silentLog, stubPool, testConfig, type SqlHandler } from './helpers.js';

const suaLine = (movement: string, nss: string, ref: string, sbcCents: number, fecha: string) =>
    movement + padLeft(nss, 11) + padRight(ref, 20) + padLeft(sbcCents, 11) + fecha;

const ADAPTER_PERIOD = {
    id: 5,
    frequency: 'catorcenal' as const,
    period_start: '2025-01-01',
    period_end: '2025-01-14', // 14 calendar days
    legal_entity: 'Strafor MX'
};

function suaCtx(handler?: SqlHandler) {
    const dir = mkdtempSync(path.join(tmpdir(), 'sua-test-'));
    const importsDir = path.join(dir, 'imports');
    const exportsDir = path.join(dir, 'exports');
    const stub = stubPool(handler);
    return {
        dir,
        importsDir,
        exportsDir,
        stub,
        adapter: createSuaFileAdapter({ importsDir, exportsDir, pool: stub.pool })
    };
}

describe('sua_file adapter — fetchPeriodResults', () => {
    it('parses a SUA file and resolves employees via employee_fiscal_mx.nss', async () => {
        const { adapter, importsDir, stub } = suaCtx((text) => {
            if (text.includes('FROM employee_fiscal_mx WHERE nss = ANY')) {
                return { rows: [{ employee_id: 7, nss: '12345678901' }] };
            }
            return { rows: [] };
        });
        mkdirSync(importsDir, { recursive: true });
        writeFileSync(
            path.join(importsDir, 'period-5.sua.txt'),
            [
                suaLine('02', '12345678901', 'EMP-7', 100000, '20250101'),
                suaLine('08', '10987654321', 'EMP-8', 50000, '20250107')
            ].join('\n'),
            'utf8'
        );

        const items = await adapter.fetchPeriodResults(ADAPTER_PERIOD, {});
        expect(items).toHaveLength(2);

        expect(items[0]).toMatchObject({
            employeeId: 7,
            gross: 14000, // 1000 × 14 days
            net: 14000,
            providerRef: 'sua-12345678901-02-20250101'
        });
        expect(items[0]!.unmatched).toBe(false);

        // Unmatched NSS: providerRef retained, flagged, employeeId null.
        expect(items[1]).toMatchObject({
            employeeId: null,
            unmatched: true,
            gross: 7000, // 500 × 14
            providerRef: 'sua-10987654321-08-20250107'
        });
        expect(items[1]!.raw).toMatchObject({ nss: '10987654321', unmatched: true });

        const lookup = stub.calls.find((c) => c.text.includes('nss = ANY'))!;
        expect(lookup.params[0]).toEqual(['12345678901', '10987654321']);
    });

    it('emits zero-amount items for baja (07) movements', async () => {
        const { adapter, importsDir } = suaCtx(() => ({ rows: [{ employee_id: 7, nss: '12345678901' }] }));
        mkdirSync(importsDir, { recursive: true });
        writeFileSync(
            path.join(importsDir, 'period-5.sua.txt'),
            suaLine('07', '12345678901', 'EMP-7', 100000, '20250110'),
            'utf8'
        );
        const items = await adapter.fetchPeriodResults(ADAPTER_PERIOD, {});
        expect(items[0]).toMatchObject({ employeeId: 7, gross: 0, net: 0 });
        expect(items[0]!.deductions).toMatchObject({ movement: 'baja' });
    });

    it('422 when the file is missing or malformed', async () => {
        const { adapter } = suaCtx();
        await expect(adapter.fetchPeriodResults(ADAPTER_PERIOD, {})).rejects.toMatchObject({ status: 422 });

        const { adapter: a2, importsDir } = suaCtx();
        mkdirSync(importsDir, { recursive: true });
        writeFileSync(path.join(importsDir, 'period-5.sua.txt'), '99garbage\n', 'utf8');
        await expect(a2.fetchPeriodResults(ADAPTER_PERIOD, {})).rejects.toMatchObject({ status: 422 });
    });
});

describe('sua_file adapter — exportLayout', () => {
    it('renders an IDSE-style movement file to EXPORTS_DIR', async () => {
        const { adapter, exportsDir } = suaCtx(() => ({ rows: [] }));
        const items = [
            {
                employeeId: 7,
                gross: 14000,
                deductions: {},
                net: 14000,
                providerRef: 'x-1',
                raw: { nss: '12345678901', employeeRef: 'EMP-7', movement: '02' }
            },
            {
                employeeId: 8,
                gross: 7000,
                deductions: {},
                net: 7000,
                providerRef: 'x-2',
                raw: { nss: '10987654321' } // no movement → default '08'
            }
        ];
        const out = await adapter.exportLayout!(ADAPTER_PERIOD, items, {});
        expect(out.records).toBe(2);
        const text = readFileSync(out.file, 'utf8');
        expect(path.dirname(out.file)).toBe(exportsDir);
        const lines = text.trimEnd().split('\n');
        expect(lines[0]!.slice(0, 2)).toBe('02');
        expect(lines[0]!.slice(2, 13)).toBe('12345678901');
        expect(lines[0]!.slice(33, 44)).toBe('00000100000'); // sbc 1000.00
        expect(lines[1]!.slice(0, 2)).toBe('08');
        expect(lines[1]!.slice(33, 44)).toBe('00000050000'); // 7000/14 → 500.00
    });
});

describe('POST /v1/payroll/periods/:id/import with sua_file provider', () => {
    it('persists unmatched lines with status unmatched and reports the count', async () => {
        const config = testConfig();
        mkdirSync(config.IMPORTS_DIR, { recursive: true });
        writeFileSync(
            path.join(config.IMPORTS_DIR, 'period-5.sua.txt'),
            [
                suaLine('02', '12345678901', 'EMP-7', 100000, '20250101'),
                suaLine('02', '10987654321', 'EMP-8', 80000, '20250101')
            ].join('\n'),
            'utf8'
        );
        const stub = stubPool((text) => {
            if (text.includes('FROM payroll_periods WHERE id')) {
                return { rows: [{ ...PERIOD, status: 'calculating' }] };
            }
            if (text.includes('FROM payroll_providers')) {
                return {
                    rows: [{ id: 3, name: 'imss_sua', adapter: 'sua_file', config: {}, enabled: true }]
                };
            }
            if (text.includes('FROM employee_fiscal_mx WHERE nss = ANY')) {
                return { rows: [{ employee_id: 7, nss: '12345678901' }] };
            }
            return { rows: [], rowCount: 1 };
        });
        const app = createApp({ pool: stub.pool, config, publisher: recordingPublisher(), log: silentLog });
        const res = await request(app).post('/v1/payroll/periods/5/import').set(HR).send({});
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ provider: 'imss_sua', imported: 2, unmatched: 1 });

        const inserts = stub.calls.filter((c) => c.text.includes('INSERT INTO payroll_items'));
        expect(inserts).toHaveLength(2);
        expect(inserts[0]!.params[1]).toBe(7);
        expect(inserts[0]!.params[7]).toBe('imported');
        expect(inserts[1]!.params[1]).toBe(null); // unresolved NSS
        expect(inserts[1]!.params[7]).toBe('unmatched');
        expect(inserts[1]!.params[6]).toBe('sua-10987654321-02-20250101');
    });
});
