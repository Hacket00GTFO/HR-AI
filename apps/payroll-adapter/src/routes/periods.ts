import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { PayrollPeriodStatus, PayrollReconciled } from '../events.js';
import { actorOf, requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction, writeAudit } from '../db.js';
import { assertFourEyes, assertTransition, isPeriodStatus, requiresFourEyes, type PeriodStatus } from '../lifecycle.js';
import { resolveAdapter, type AdapterPeriod } from '../adapters/index.js';
import { toCsv } from '../csv.js';
import { buildDispersionFile, isValidClabe, type DispersionRecord } from '../formats.js';

export interface PeriodsDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const idParam = z.coerce.number().int().positive();
function parseId(raw: string | undefined): number {
    const parsed = idParam.safeParse(raw);
    if (!parsed.success) throw httpError(400, 'Invalid period id');
    return parsed.data;
}

const createPeriodSchema = z
    .object({
        frequency: z.enum(['catorcenal', 'mensual']),
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be YYYY-MM-DD'),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
        legalEntity: z.string().min(1).max(200).optional()
    })
    .strict()
    .refine((d) => d.periodEnd >= d.periodStart, { message: 'periodEnd must be >= periodStart' });

const statusSchema = z
    .object({
        status: z.enum(['draft', 'calculating', 'review', 'locked', 'exported', 'reconciled', 'finalized', 'cancelled'])
    })
    .strict();

const importSchema = z
    .object({
        provider: z.string().min(1).max(80).optional()
    })
    .strict();

const expectationSchema = z.object({
    employeeId: z.number().int().positive(),
    field: z.enum(['gross', 'net']),
    expected: z.number()
});

const reconcileSchema = z
    .object({
        expectations: z.array(expectationSchema).optional(),
        // Baseline shorthand: { "<employeeId>": { gross?: n, net?: n } }
        baseline: z
            .record(z.string(), z.object({ gross: z.number().optional(), net: z.number().optional() }))
            .optional(),
        // Rounding tolerance in centavos: |actual - expected| ≤ toleranceCents
        // counts as matched (no delta row). Default 1.
        toleranceCents: z.number().int().min(0).max(1000).optional()
    })
    .strict()
    .refine((d) => (d.expectations?.length ?? 0) > 0 || Object.keys(d.baseline ?? {}).length > 0, {
        message: 'Provide expectations[] or a baseline map'
    });

const exportSchema = z
    .object({
        kind: z.enum(['provider_import', 'bank_disperse']),
        format: z.enum(['csv']).default('csv')
    })
    .strict();

const dispersionSchema = z
    .object({
        // Optional: name of the bank_dispersion provider whose config supplies
        // the empresa RFC. Defaults to the first enabled bank_dispersion
        // provider, else the placeholder RFC.
        provider: z.string().min(1).max(80).optional()
    })
    .strict();

// Statuses in which provider results may be (re-)imported.
const IMPORTABLE: readonly PeriodStatus[] = ['calculating', 'review'];
// Reconcile (shadow-mode diff) is meaningful once items can exist and the
// period isn't terminal.
const RECONCILABLE: readonly PeriodStatus[] = ['calculating', 'review', 'locked', 'exported', 'reconciled'];
// Disbursement/export files only after the period is locked.
const EXPORTABLE: readonly PeriodStatus[] = ['locked', 'exported', 'reconciled'];
// Bank dispersion is generated only once the period's export is done.
const DISPERSABLE: readonly PeriodStatus[] = ['exported', 'reconciled'];

interface PeriodRow {
    id: number | string;
    frequency: string;
    period_start: string | Date;
    period_end: string | Date;
    legal_entity: string | null;
    status: string;
    created_by: number | null;
    approved_by: number | null;
    created_at: unknown;
    updated_at: unknown;
}

const dateOnly = (v: string | Date) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function rowToPeriod(r: PeriodRow) {
    return {
        id: Number(r.id),
        frequency: r.frequency,
        periodStart: dateOnly(r.period_start),
        periodEnd: dateOnly(r.period_end),
        legalEntity: r.legal_entity,
        status: r.status,
        createdBy: r.created_by != null ? Number(r.created_by) : null,
        approvedBy: r.approved_by != null ? Number(r.approved_by) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at
    };
}

function rowToItem(r: Record<string, unknown>) {
    return {
        id: Number(r.id),
        periodId: Number(r.period_id),
        employeeId: r.employee_id == null ? null : Number(r.employee_id),
        provider: r.provider,
        gross: Number(r.gross),
        deductions: r.deductions,
        net: Number(r.net),
        providerRef: r.provider_ref,
        status: r.status,
        raw: r.raw,
        createdAt: r.created_at,
        updatedAt: r.updated_at
    };
}

export function periodsRouter(deps: PeriodsDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();

    // Every payroll endpoint requires HR — admins get 403 (payroll is strictly
    // HR/Finance). Trusted internal callers may present X-Service-Token.
    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR);

    async function loadPeriod(id: number): Promise<PeriodRow> {
        const { rows } = await pool.query(`SELECT * FROM payroll_periods WHERE id = $1`, [id]);
        if (!rows[0]) throw httpError(404, 'Payroll period not found');
        return rows[0] as PeriodRow;
    }

    // POST /v1/payroll/periods — create a draft period.
    router.post('/', async (req, res, next) => {
        try {
            const parsed = createPeriodSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid period payload', parsed.error.issues);
            const d = parsed.data;
            const createdBy = req.user?.userId ?? null;
            const { rows } = await pool.query(
                `INSERT INTO payroll_periods (frequency, period_start, period_end, legal_entity, created_by)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [d.frequency, d.periodStart, d.periodEnd, d.legalEntity ?? null, createdBy]
            );
            const row = rows[0] as PeriodRow;
            await writeAudit(pool, {
                actor: actorOf(req),
                action: 'period.create',
                entity: 'payroll_periods',
                entityId: row.id,
                metadata: { frequency: d.frequency, periodStart: d.periodStart, periodEnd: d.periodEnd }
            });
            log.info({ periodId: row.id }, 'payroll period created');
            res.status(201).json(rowToPeriod(row));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/payroll/periods — allowlisted ?status= & ?frequency= filters.
    router.get('/', async (req, res, next) => {
        try {
            const where: string[] = [];
            const params: unknown[] = [];
            if (req.query.status !== undefined) {
                if (!isPeriodStatus(req.query.status)) throw httpError(400, 'Invalid status filter');
                params.push(req.query.status);
                where.push(`status = $${params.length}`);
            }
            if (req.query.frequency !== undefined) {
                if (!['catorcenal', 'mensual'].includes(String(req.query.frequency))) {
                    throw httpError(400, 'Invalid frequency filter');
                }
                params.push(req.query.frequency);
                where.push(`frequency = $${params.length}`);
            }
            const sql =
                `SELECT * FROM payroll_periods` +
                (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
                ` ORDER BY period_start DESC, id DESC`;
            const { rows } = await pool.query(sql, params);
            res.json(rows.map((r) => rowToPeriod(r as PeriodRow)));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/payroll/periods/:id
    router.get('/:id(\\d+)', async (req, res, next) => {
        try {
            const row = await loadPeriod(parseId(req.params.id));
            res.json(rowToPeriod(row));
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/payroll/periods/:id/status — strict lifecycle transition.
    router.put('/:id(\\d+)/status', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = statusSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid status payload', parsed.error.issues);
            const to = parsed.data.status;

            const updated = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM payroll_periods WHERE id = $1 FOR UPDATE`, [id]);
                const period = rows[0] as PeriodRow | undefined;
                if (!period) throw httpError(404, 'Payroll period not found');
                const from = period.status as PeriodStatus;

                assertTransition(from, to);
                const approverId = req.user?.userId ?? null;
                assertFourEyes(from, to, period.created_by != null ? Number(period.created_by) : null, approverId);

                const fourEyes = requiresFourEyes(from, to);
                const setApprover = fourEyes ? ', approved_by = $4' : '';
                const params: unknown[] = fourEyes ? [id, to, from, approverId] : [id, to, from];
                const { rows: upd } = await client.query(
                    `UPDATE payroll_periods SET status = $2${setApprover}, updated_at = now()
                     WHERE id = $1 AND status = $3 RETURNING *`,
                    params
                );
                if (!upd[0]) throw httpError(409, 'Period status changed concurrently — retry');
                await writeAudit(client, {
                    actor: actorOf(req),
                    action: 'period.status',
                    entity: 'payroll_periods',
                    entityId: id,
                    metadata: { from, to }
                });
                return { row: upd[0] as PeriodRow, from };
            });

            await publisher.publish(
                PayrollPeriodStatus,
                'strafor.payroll.period_status',
                {
                    periodId: id,
                    frequency: updated.row.frequency,
                    from: updated.from,
                    to,
                    actor: actorOf(req)
                },
                req.correlationId
            );
            res.json(rowToPeriod(updated.row));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/payroll/periods/:id/items — imported provider line items.
    router.get('/:id(\\d+)/items', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            await loadPeriod(id);
            const { rows } = await pool.query(
                `SELECT * FROM payroll_items WHERE period_id = $1 ORDER BY employee_id, id`,
                [id]
            );
            res.json(rows.map(rowToItem));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/payroll/periods/:id/import — pull provider results via the
    // configured adapter and upsert payroll_items (idempotent on provider_ref).
    router.post('/:id(\\d+)/import', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = importSchema.safeParse(req.body ?? {});
            if (!parsed.success) throw httpError(400, 'Invalid import payload', parsed.error.issues);

            const period = await loadPeriod(id);
            if (!IMPORTABLE.includes(period.status as PeriodStatus)) {
                throw httpError(409, `Cannot import provider results while period is '${period.status}'`);
            }

            const providerSql = parsed.data.provider
                ? `SELECT * FROM payroll_providers WHERE name = $1 AND enabled = true`
                : `SELECT * FROM payroll_providers WHERE enabled = true ORDER BY id LIMIT 1`;
            const { rows: providers } = await pool.query(
                providerSql,
                parsed.data.provider ? [parsed.data.provider] : []
            );
            const provider = providers[0] as
                { id: number; name: string; adapter: string; config: Record<string, unknown> } | undefined;
            if (!provider) {
                throw httpError(
                    422,
                    parsed.data.provider
                        ? `Provider '${parsed.data.provider}' not found or disabled`
                        : 'No enabled payroll provider configured'
                );
            }

            const adapter = resolveAdapter(provider.adapter, {
                importsDir: config.IMPORTS_DIR,
                exportsDir: config.EXPORTS_DIR,
                pool
            });
            const adapterPeriod: AdapterPeriod = {
                id: Number(period.id),
                frequency: period.frequency as AdapterPeriod['frequency'],
                period_start: dateOnly(period.period_start),
                period_end: dateOnly(period.period_end),
                legal_entity: period.legal_entity
            };
            const items = await adapter.fetchPeriodResults(adapterPeriod, provider.config ?? {});

            const upserted = await withTransaction(pool, async (client) => {
                let count = 0;
                for (const item of items) {
                    // Unmatched provider lines (e.g. SUA NSS with no fiscal
                    // record) keep their providerRef but land as 'unmatched'.
                    const status = item.employeeId == null || item.unmatched ? 'unmatched' : 'imported';
                    const { rowCount } = await client.query(
                        `INSERT INTO payroll_items
                             (period_id, employee_id, provider, gross, deductions, net, provider_ref, status, raw)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                         ON CONFLICT (period_id, provider_ref) DO UPDATE SET
                             gross = EXCLUDED.gross,
                             deductions = EXCLUDED.deductions,
                             net = EXCLUDED.net,
                             status = EXCLUDED.status,
                             raw = EXCLUDED.raw,
                             updated_at = now()`,
                        [
                            id,
                            item.employeeId,
                            provider.name,
                            item.gross,
                            JSON.stringify(item.deductions),
                            item.net,
                            item.providerRef,
                            status,
                            JSON.stringify(item.raw)
                        ]
                    );
                    count += rowCount ?? 0;
                }
                await writeAudit(client, {
                    actor: actorOf(req),
                    action: 'period.import',
                    entity: 'payroll_periods',
                    entityId: id,
                    metadata: { provider: provider.name, adapter: provider.adapter, items: items.length }
                });
                return count;
            });

            const unmatched = items.filter((i) => i.employeeId == null || i.unmatched).length;
            log.info(
                { periodId: id, provider: provider.name, items: items.length, unmatched },
                'payroll items imported'
            );
            res.json({ periodId: id, provider: provider.name, imported: items.length, unmatched, upserted });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/payroll/periods/:id/reconcile — shadow-mode comparison of
    // imported items vs expected values; writes a reconciliation row per delta.
    router.post('/:id(\\d+)/reconcile', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = reconcileSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid reconcile payload', parsed.error.issues);

            const period = await loadPeriod(id);
            if (!RECONCILABLE.includes(period.status as PeriodStatus)) {
                throw httpError(409, `Cannot reconcile while period is '${period.status}'`);
            }

            const expectations = [...(parsed.data.expectations ?? [])];
            for (const [empId, amounts] of Object.entries(parsed.data.baseline ?? {})) {
                const employeeId = Number(empId);
                if (!Number.isInteger(employeeId) || employeeId <= 0) {
                    throw httpError(400, `Invalid baseline employee id '${empId}'`);
                }
                if (amounts.gross !== undefined)
                    expectations.push({ employeeId, field: 'gross', expected: amounts.gross });
                if (amounts.net !== undefined) expectations.push({ employeeId, field: 'net', expected: amounts.net });
            }

            const { rows: itemRows } = await pool.query(
                `SELECT employee_id, gross, net FROM payroll_items WHERE period_id = $1`,
                [id]
            );
            const byEmployee = new Map<number, { gross: number; net: number }>();
            for (const r of itemRows) {
                if (r.employee_id == null) continue; // unmatched provider lines
                byEmployee.set(Number(r.employee_id), { gross: Number(r.gross), net: Number(r.net) });
            }

            const toleranceCents = parsed.data.toleranceCents ?? 1;
            const deltas = await withTransaction(pool, async (client) => {
                let count = 0;
                for (const e of expectations) {
                    const item = byEmployee.get(e.employeeId);
                    const actual = item ? item[e.field] : null;
                    const deltaCents = actual === null ? null : Math.round((actual - e.expected) * 100);
                    const isDelta = actual === null || Math.abs(deltaCents!) > toleranceCents;
                    if (!isDelta) continue;
                    const delta = deltaCents === null ? null : deltaCents / 100;
                    await client.query(
                        `INSERT INTO payroll_reconciliations
                             (period_id, employee_id, field, expected, actual, delta)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [id, e.employeeId, e.field, e.expected, actual, delta]
                    );
                    count++;
                }
                await writeAudit(client, {
                    actor: actorOf(req),
                    action: 'period.reconcile',
                    entity: 'payroll_periods',
                    entityId: id,
                    metadata: { compared: expectations.length, deltas: count, toleranceCents }
                });
                return count;
            });

            await publisher.publish(
                PayrollReconciled,
                'strafor.payroll.reconciled',
                { periodId: id, compared: expectations.length, deltas },
                req.correlationId
            );
            res.json({ periodId: id, compared: expectations.length, deltas, toleranceCents });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/payroll/periods/:id/export — generate an export file into
    // EXPORTS_DIR and register a payroll_exports row.
    router.post('/:id(\\d+)/export', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = exportSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid export payload', parsed.error.issues);
            const { kind, format } = parsed.data;

            const period = await loadPeriod(id);
            if (!EXPORTABLE.includes(period.status as PeriodStatus)) {
                throw httpError(409, `Cannot export while period is '${period.status}' (lock it first)`);
            }

            let csv: string;
            if (kind === 'bank_disperse') {
                const { rows } = await pool.query(
                    `SELECT i.employee_id, i.net, i.provider_ref,
                            f.clabe, f.bank_code, f.rfc
                     FROM payroll_items i
                     LEFT JOIN employee_fiscal_mx f ON f.employee_id = i.employee_id
                     WHERE i.period_id = $1
                     ORDER BY i.employee_id`,
                    [id]
                );
                csv = toCsv(
                    ['employee_id', 'clabe', 'bank_code', 'rfc', 'net', 'provider_ref'],
                    rows.map((r) => [r.employee_id, r.clabe, r.bank_code, r.rfc, r.net, r.provider_ref])
                );
            } else {
                const { rows } = await pool.query(
                    `SELECT employee_id, gross, deductions, net, provider, provider_ref
                     FROM payroll_items WHERE period_id = $1 ORDER BY employee_id`,
                    [id]
                );
                csv = toCsv(
                    ['employee_id', 'gross', 'deductions', 'net', 'provider', 'provider_ref'],
                    rows.map((r) => [
                        r.employee_id,
                        r.gross,
                        typeof r.deductions === 'string' ? r.deductions : JSON.stringify(r.deductions ?? {}),
                        r.net,
                        r.provider,
                        r.provider_ref
                    ])
                );
            }

            const filename = `period-${id}-${kind}-${Date.now()}.${format}`;
            const storageRef = path.join(config.EXPORTS_DIR, filename);
            await fs.mkdir(config.EXPORTS_DIR, { recursive: true });
            await fs.writeFile(storageRef, csv, 'utf8');

            const generatedBy = req.user?.userId ?? null;
            const { rows } = await pool.query(
                `INSERT INTO payroll_exports (period_id, kind, format, storage_ref, generated_by)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, period_id, kind, format, storage_ref, generated_by, generated_at`,
                [id, kind, format, storageRef, generatedBy]
            );
            await writeAudit(pool, {
                actor: actorOf(req),
                action: 'period.export',
                entity: 'payroll_periods',
                entityId: id,
                metadata: { kind, format, storageRef }
            });
            const r = rows[0]!;
            log.info({ periodId: id, kind, exportId: r.id }, 'payroll export generated');
            res.status(201).json({
                id: Number(r.id),
                periodId: id,
                kind: r.kind,
                format: r.format,
                storageRef: r.storage_ref,
                generatedBy: r.generated_by,
                generatedAt: r.generated_at
            });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/payroll/periods/:id/dispersion — generate the CLABE-
    // interbancaria bank-dispersion file (see src/formats.ts for the record
    // layout) into EXPORTS_DIR and register a payroll_exports 'dispersion' row.
    router.post('/:id(\\d+)/dispersion', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = dispersionSchema.safeParse(req.body ?? {});
            if (!parsed.success) throw httpError(400, 'Invalid dispersion payload', parsed.error.issues);

            const period = await loadPeriod(id);
            if (!DISPERSABLE.includes(period.status as PeriodStatus)) {
                throw httpError(
                    409,
                    `Cannot generate bank dispersion while period is '${period.status}' (must be exported or reconciled)`
                );
            }

            // Empresa RFC for the header record comes from the bank_dispersion
            // provider config; the placeholder is used when none is configured.
            const providerSql = parsed.data.provider
                ? `SELECT * FROM payroll_providers WHERE name = $1 AND enabled = true`
                : `SELECT * FROM payroll_providers WHERE adapter = 'bank_dispersion' AND enabled = true ORDER BY id LIMIT 1`;
            const { rows: providers } = await pool.query(
                providerSql,
                parsed.data.provider ? [parsed.data.provider] : []
            );
            const provider = providers[0] as { config?: Record<string, unknown> } | undefined;
            if (parsed.data.provider && !provider) {
                throw httpError(422, `Provider '${parsed.data.provider}' not found or disabled`);
            }
            const rfc =
                typeof provider?.config?.rfc === 'string' && provider.config.rfc
                    ? provider.config.rfc
                    : 'XAXX010101000';

            const { rows } = await pool.query(
                `SELECT i.employee_id, i.net, i.provider_ref, f.clabe, f.bank_name
                 FROM payroll_items i
                 LEFT JOIN employee_fiscal_mx f ON f.employee_id = i.employee_id
                 WHERE i.period_id = $1 AND i.employee_id IS NOT NULL
                 ORDER BY i.employee_id`,
                [id]
            );
            if (rows.length === 0) {
                throw httpError(422, `Period ${id} has no payroll items to disperse`);
            }

            const invalid: number[] = [];
            const records: DispersionRecord[] = rows.map((r) => {
                const clabe = typeof r.clabe === 'string' ? r.clabe : null;
                if (!isValidClabe(clabe)) invalid.push(Number(r.employee_id));
                return {
                    clabe: clabe ?? '',
                    amountCents: Math.round(Number(r.net) * 100),
                    ref: String(r.provider_ref ?? r.employee_id)
                };
            });
            if (invalid.length > 0) {
                throw httpError(422, `${invalid.length} item(s) have a missing or invalid CLABE`, {
                    employeeIds: invalid
                });
            }

            const fecha = new Date().toISOString().slice(0, 10).replaceAll('-', '');
            const file = buildDispersionFile({ rfc, fecha, records });
            const filename = `dispersion-${id}.txt`;
            const storageRef = path.join(config.EXPORTS_DIR, filename);
            await fs.mkdir(config.EXPORTS_DIR, { recursive: true });
            await fs.writeFile(storageRef, file.text, 'utf8');

            const generatedBy = req.user?.userId ?? null;
            const { rows: exportRows } = await pool.query(
                `INSERT INTO payroll_exports (period_id, kind, format, storage_ref, generated_by)
                 VALUES ($1, 'dispersion', 'txt', $2, $3)
                 RETURNING id, period_id, kind, format, storage_ref, generated_by, generated_at`,
                [id, storageRef, generatedBy]
            );
            // Aggregate-only metadata — no employee-level PII in the audit row.
            await writeAudit(pool, {
                actor: actorOf(req),
                action: 'dispersion_export',
                entity: 'payroll_periods',
                entityId: id,
                metadata: { count: file.count, totalCents: file.totalCents, file: filename }
            });
            const r = exportRows[0]!;
            log.info({ periodId: id, exportId: r.id, count: file.count }, 'bank dispersion file generated');
            res.status(201).json({
                id: Number(r.id),
                periodId: id,
                kind: 'dispersion',
                format: 'txt',
                storageRef: r.storage_ref,
                count: file.count,
                totalCents: file.totalCents,
                generatedBy: r.generated_by,
                generatedAt: r.generated_at
            });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
