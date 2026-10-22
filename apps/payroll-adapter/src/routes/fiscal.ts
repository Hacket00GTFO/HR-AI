import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { actorOf, requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction, writeAudit } from '../db.js';

export interface FiscalDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const employeeIdParam = z.coerce.number().int().positive();

const upsertSchema = z
    .object({
        rfc: z.string().min(12).max(13).optional(),
        curp: z.string().length(18).optional(),
        nss: z.string().length(11).optional(),
        clabe: z.string().length(18).optional(),
        bankCode: z.string().min(1).max(10).optional(),
        bankName: z.string().min(1).max(100).optional(),
        legalEntity: z.string().min(1).max(200).optional(),
        regime: z.string().min(1).max(60).optional(),
        contractType: z.string().min(1).max(60).optional()
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one fiscal field is required' });

const FIELD_MAP: Record<string, string> = {
    rfc: 'rfc',
    curp: 'curp',
    nss: 'nss',
    clabe: 'clabe',
    bankCode: 'bank_code',
    bankName: 'bank_name',
    legalEntity: 'legal_entity',
    regime: 'regime',
    contractType: 'contract_type'
};

function rowToFiscal(r: Record<string, unknown>) {
    return {
        employeeId: Number(r.employee_id),
        rfc: r.rfc,
        curp: r.curp,
        nss: r.nss,
        clabe: r.clabe,
        bankCode: r.bank_code,
        bankName: r.bank_name,
        legalEntity: r.legal_entity,
        regime: r.regime,
        contractType: r.contract_type,
        createdAt: r.created_at,
        updatedAt: r.updated_at
    };
}

export function fiscalRouter(deps: FiscalDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    // Fiscal data is the most sensitive surface in the service: HR-only, and
    // EVERY read and write is audit-logged (admin → 403 via requireHR).
    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR);

    // GET /v1/payroll/fiscal/:employeeId — audited read.
    router.get('/:employeeId(\\d+)', async (req, res, next) => {
        try {
            const parsed = employeeIdParam.safeParse(req.params.employeeId);
            if (!parsed.success) throw httpError(400, 'Invalid employee id');
            const employeeId = parsed.data;

            const { rows } = await pool.query(`SELECT * FROM employee_fiscal_mx WHERE employee_id = $1`, [employeeId]);
            // Audit the access even on a miss — the read attempt itself is sensitive.
            await writeAudit(pool, {
                actor: actorOf(req),
                action: 'fiscal.read',
                entity: 'employee_fiscal_mx',
                entityId: employeeId,
                metadata: { found: Boolean(rows[0]) }
            });
            if (!rows[0]) throw httpError(404, 'Fiscal record not found');
            res.json(rowToFiscal(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/payroll/fiscal/:employeeId — upsert, audited write.
    router.put('/:employeeId(\\d+)', async (req, res, next) => {
        try {
            const parsed = employeeIdParam.safeParse(req.params.employeeId);
            if (!parsed.success) throw httpError(400, 'Invalid employee id');
            const employeeId = parsed.data;

            const body = upsertSchema.safeParse(req.body);
            if (!body.success) throw httpError(400, 'Invalid fiscal payload', body.error.issues);

            const columns: string[] = [];
            const values: unknown[] = [];
            for (const [key, col] of Object.entries(FIELD_MAP)) {
                const v = (body.data as Record<string, unknown>)[key];
                if (v !== undefined) {
                    columns.push(col);
                    values.push(v);
                }
            }

            const row = await withTransaction(pool, async (client) => {
                const insertCols = ['employee_id', ...columns];
                const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
                const updateSets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
                const { rows } = await client.query(
                    `INSERT INTO employee_fiscal_mx (${insertCols.join(', ')})
                     VALUES (${placeholders})
                     ON CONFLICT (employee_id) DO UPDATE SET ${updateSets}, updated_at = now()
                     RETURNING *`,
                    [employeeId, ...values]
                );
                await writeAudit(client, {
                    actor: actorOf(req),
                    action: 'fiscal.upsert',
                    entity: 'employee_fiscal_mx',
                    entityId: employeeId,
                    metadata: { fields: columns }
                });
                return rows[0] as Record<string, unknown>;
            });

            res.json(rowToFiscal(row));
        } catch (err) {
            next(err);
        }
    });

    return router;
}
