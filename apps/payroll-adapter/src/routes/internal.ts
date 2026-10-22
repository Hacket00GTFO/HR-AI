import { Router } from 'express';
import { z } from 'zod';
import { httpError } from '@strafor/node-common';
import type { PayrollDeps } from '../app.js';
import { requireService } from '../auth.js';
import { withTransaction, writeAudit } from '../db.js';

/**
 * Internal-only routes — reachable exclusively with X-Service-Token, never
 * with user identity headers.
 *
 * DSAR fan-out endpoints called by apps/api utils/dsar.js. Payroll data is
 * keyed by `employee_id` (hr-core employee id); the caller resolves the
 * subject's email/user id upstream and passes `employeeId`. A bare numeric
 * subjectKey is also accepted as an employee id.
 *
 * ERASURE SEMANTICS — LEGAL HOLD: Mexican fiscal and labour law (CFF
 * art. 30 — 5-year retention; LFT/IMSS payroll record duties) requires
 * payroll data to be retained even when a data subject exercises erasure.
 * dsar-erase therefore PSEUDONYMISES employee_fiscal_mx (personal fiscal
 * identifiers → NULL, legal_hold=true, erased_at set) and KEEPS
 * payroll_items / payroll_reconciliations untouched — their employee_id is
 * non-identifying once hr-core erases the person. The response detail flags
 * `legalHold: true` so the orchestrator's audit trail records that erasure
 * was partial-by-law, not a failure.
 */

const dsarRequestSchema = z
    .object({
        subjectKey: z.string().min(1).max(320),
        requestId: z.union([z.string().min(1).max(128), z.number().int().positive()]),
        email: z.string().email().max(255).optional(),
        userId: z.number().int().positive().optional(),
        employeeId: z.number().int().positive().optional()
    })
    .strict();

function resolveEmployeeId(d: z.infer<typeof dsarRequestSchema>): number | null {
    if (d.employeeId != null) return d.employeeId;
    if (/^\d+$/.test(d.subjectKey)) return Number(d.subjectKey);
    return null;
}

export function internalRouter(deps: PayrollDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    router.use(requireService(config.SERVICE_AUTH_TOKEN));

    // POST /v1/internal/dsar-export — fiscal row + payroll history for the
    // subject's employee_id. Every fiscal-table read is audit-logged, same
    // as the HR-facing fiscal router.
    router.post('/dsar-export', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const employeeId = resolveEmployeeId(parsed.data);
            if (employeeId == null) {
                res.json({ found: false, reason: 'employee_unresolved' });
                return;
            }

            const { rows: fiscal } = await pool.query('SELECT * FROM employee_fiscal_mx WHERE employee_id = $1', [
                employeeId
            ]);
            const { rows: items } = await pool.query(
                `SELECT pi.*, pp.period_start, pp.period_end, pp.frequency
                   FROM payroll_items pi JOIN payroll_periods pp ON pp.id = pi.period_id
                  WHERE pi.employee_id = $1 ORDER BY pp.period_start`,
                [employeeId]
            );
            const { rows: reconciliations } = await pool.query(
                'SELECT * FROM payroll_reconciliations WHERE employee_id = $1 ORDER BY created_at',
                [employeeId]
            );

            await writeAudit(pool, {
                actor: 'service',
                action: 'dsar.export',
                entity: 'employee_fiscal_mx',
                entityId: employeeId,
                metadata: { requestId: parsed.data.requestId }
            });

            res.json({
                found: fiscal.length + items.length + reconciliations.length > 0,
                employee_id: employeeId,
                employee_fiscal_mx: fiscal[0] ?? null,
                payroll_items: items,
                payroll_reconciliations: reconciliations
            });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/internal/dsar-erase — pseudonymise employee_fiscal_mx under
    // legal hold (see header comment). Idempotent: re-running re-applies the
    // same NULL pseudonymisation and reports erased:true again.
    router.post('/dsar-erase', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const employeeId = resolveEmployeeId(parsed.data);
            if (employeeId == null) {
                res.json({ erased: false, detail: { reason: 'employee_unresolved' } });
                return;
            }

            const detail = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `UPDATE employee_fiscal_mx SET
                        rfc = NULL, curp = NULL, nss = NULL,
                        clabe = NULL, bank_code = NULL,
                        legal_hold = true, erased_at = now()
                     WHERE employee_id = $1
                     RETURNING id`,
                    [employeeId]
                );
                const fiscalRow = rows[0] as Record<string, unknown> | undefined;
                await writeAudit(client, {
                    actor: 'service',
                    action: 'dsar.erase',
                    entity: 'employee_fiscal_mx',
                    entityId: employeeId,
                    metadata: {
                        requestId: parsed.data.requestId,
                        legalHold: true,
                        pseudonymized: fiscalRow != null
                    }
                });
                if (!fiscalRow) return null;
                return {
                    employeeId,
                    fiscalRowId: fiscalRow['id'],
                    legalHold: true,
                    pseudonymized: 'employee_fiscal_mx',
                    // Retained under statutory duty — amounts, not identifiers.
                    retained: ['payroll_items', 'payroll_reconciliations']
                };
            });

            if (!detail) {
                // No fiscal row for this employee — nothing to pseudonymise.
                res.json({ erased: false, detail: { reason: 'no_matching_fiscal_row' } });
                return;
            }
            res.json({ erased: true, detail });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
