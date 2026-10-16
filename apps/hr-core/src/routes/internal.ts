import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { requireService } from '../auth.js';
import { withTransaction } from '../db.js';

export interface InternalDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const upsertSchema = z
    .object({
        users: z
            .array(
                z
                    .object({
                        id: z.number().int().positive(),
                        firstName: z.string().max(100).nullable().optional(),
                        lastName: z.string().max(100).nullable().optional()
                    })
                    .strict()
            )
            .min(1)
            .max(500)
    })
    .strict();

/**
 * DSAR fan-out request (apps/api utils/dsar.js). For this employee-domain
 * service the subject key is the employee email OR identity user id; the
 * caller also passes email/userId/employeeId explicitly when resolved.
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

/** Resolve the live employee row by employeeId → userId → email, in order. */
async function findSubjectEmployee(
    pool: Pool,
    d: z.infer<typeof dsarRequestSchema>
): Promise<Record<string, unknown> | null> {
    const numericKey = /^\d+$/.test(d.subjectKey) ? Number(d.subjectKey) : null;
    const employeeId = d.employeeId ?? numericKey;
    const userId = d.userId ?? numericKey;
    const email = (d.email ?? (d.subjectKey.includes('@') ? d.subjectKey : undefined))?.toLowerCase();

    if (employeeId != null) {
        const { rows } = await pool.query('SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL', [employeeId]);
        if (rows[0]) return rows[0];
    }
    if (userId != null) {
        const { rows } = await pool.query('SELECT * FROM employees WHERE user_id = $1 AND deleted_at IS NULL', [
            userId
        ]);
        if (rows[0]) return rows[0];
    }
    if (email) {
        const { rows } = await pool.query('SELECT * FROM employees WHERE lower(email) = $1 AND deleted_at IS NULL', [
            email
        ]);
        if (rows[0]) return rows[0];
    }
    return null;
}

/**
 * Internal-only routes — reachable exclusively with X-Service-Token, never
 * with user identity headers. Used by identity-auth/monolith sync jobs to
 * keep users_projection (display names) fresh until a real consumer exists.
 */
export function internalRouter(deps: InternalDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    router.use(requireService(config.SERVICE_AUTH_TOKEN));

    // POST /v1/internal/users-projection — bulk upsert display names.
    router.post('/users-projection', async (req, res, next) => {
        try {
            const parsed = upsertSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid users payload', parsed.error.issues);
            let upserted = 0;
            for (const u of parsed.data.users) {
                await pool.query(
                    `INSERT INTO users_projection (id, first_name, last_name)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (id) DO UPDATE
                     SET first_name = EXCLUDED.first_name,
                         last_name = EXCLUDED.last_name,
                         updated_at = now()`,
                    [u.id, u.firstName ?? null, u.lastName ?? null]
                );
                upserted += 1;
            }
            res.json({ upserted });
        } catch (err) {
            next(err);
        }
    });

    // DELETE /v1/internal/users-projection/:id — drop a stale projection row.
    router.delete('/users-projection/:id(\\d+)', async (req, res, next) => {
        try {
            const { rowCount } = await pool.query(`DELETE FROM users_projection WHERE id = $1`, [
                Number(req.params.id)
            ]);
            if (!rowCount) throw httpError(404, 'Projection row not found');
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    });

    // ---- DSAR (data-subject access/erasure) — service-token only. ----
    // POST /v1/internal/dsar-export — everything held about the employee.
    router.post('/dsar-export', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const employee = await findSubjectEmployee(pool, parsed.data);
            if (!employee) {
                res.json({ found: false, employee: null });
                return;
            }
            const empId = employee['id'] as number;

            const { rows: documents } = await pool.query(
                'SELECT * FROM employee_documents WHERE employee_id = $1 ORDER BY created_at',
                [empId]
            );
            const { rows: cases } = await pool.query(
                'SELECT * FROM onboarding_cases WHERE employee_id = $1 ORDER BY created_at',
                [empId]
            );
            const caseIds = cases.map((c: Record<string, unknown>) => c['id']);
            const { rows: tasks } =
                caseIds.length > 0
                    ? await pool.query('SELECT * FROM onboarding_tasks WHERE case_id = ANY($1)', [caseIds])
                    : { rows: [] };

            res.json({
                found: true,
                employee,
                employee_documents: documents,
                onboarding_cases: cases,
                onboarding_tasks: tasks
            });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/internal/dsar-erase — pseudonymise the employee PII and drop
    // document links. The row itself stays (employment lifecycle records are
    // operational); all identifying fields are erased so the residual record
    // no longer maps to a person. Idempotent: a re-run finds no row under the
    // original email and reports erased:false / no_matching_employee.
    router.post('/dsar-erase', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const employee = await findSubjectEmployee(pool, parsed.data);
            if (!employee) {
                res.json({ erased: false, detail: { reason: 'no_matching_employee' } });
                return;
            }
            const empId = employee['id'] as number;

            const detail = await withTransaction(pool, async (client) => {
                await client.query(
                    `UPDATE employees SET
                        first_name = '[erased]', last_name = '[erased]',
                        email = $2, phone = NULL, location = NULL,
                        rfc = NULL, curp = NULL, nss = NULL,
                        salary = NULL, position = NULL,
                        user_id = NULL
                     WHERE id = $1`,
                    [empId, `erased+${empId}@erased.invalid`]
                );
                const { rowCount: docs } = await client.query('DELETE FROM employee_documents WHERE employee_id = $1', [
                    empId
                ]);
                return { employeeId: empId, documentLinksRemoved: docs ?? 0 };
            });

            res.json({ erased: true, detail });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
