import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { requireService } from '../auth.js';
import { withTransaction, type Queryable } from '../db.js';
import { respondentHash } from './surveys.js';

export interface InternalDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const upsertSchema = z
    .object({
        employees: z
            .array(
                z
                    .object({
                        id: z.number().int().positive(),
                        userId: z.number().int().positive(),
                        firstName: z.string().max(100).nullable().optional(),
                        lastName: z.string().max(100).nullable().optional(),
                        department: z.string().max(100).nullable().optional()
                    })
                    .strict()
            )
            .min(1)
            .max(500)
    })
    .strict();

/**
 * DSAR fan-out request (apps/api utils/dsar.js). Employee-domain service:
 * the subject resolves to an hr-core employee_id — taken from `employeeId`,
 * a numeric subjectKey, or via employee_directory (user_id → id).
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

/** employeeId → numeric subjectKey → employee_directory(user_id) lookup. */
async function resolveEmployeeId(pool: Pool, d: z.infer<typeof dsarRequestSchema>): Promise<number | null> {
    if (d.employeeId != null) return d.employeeId;
    if (/^\d+$/.test(d.subjectKey)) return Number(d.subjectKey);
    if (d.userId != null) {
        const { rows } = await pool.query('SELECT id FROM employee_directory WHERE user_id = $1', [d.userId]);
        if (rows[0]) return Number((rows[0] as Record<string, unknown>)['id']);
    }
    return null;
}

/**
 * survey_responses are pseudonymous: respondent_hash = HMAC-SHA256(salt,
 * '<surveyId>:<employeeId>') and the raw employee_id is never stored, so the
 * link can only be re-created forward — compute the hash per survey and
 * match on (survey_id, respondent_hash).
 */
async function surveyIds(db: Queryable): Promise<number[]> {
    const { rows } = await db.query('SELECT id FROM surveys');
    return rows.map((r) => Number((r as Record<string, unknown>)['id']));
}

/**
 * Internal-only routes — reachable exclusively with X-Service-Token, never
 * with user identity headers. The employee_directory projection maps
 * identity users to hr-core employee ids (self-service scoping) and carries
 * the department used to bucket anonymous survey respondents.
 */
export function internalRouter(deps: InternalDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    router.use(requireService(config.SERVICE_AUTH_TOKEN));

    // POST /v1/internal/employee-directory — bulk upsert the projection.
    router.post('/employee-directory', async (req, res, next) => {
        try {
            const parsed = upsertSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid employees payload', parsed.error.issues);
            let upserted = 0;
            for (const e of parsed.data.employees) {
                await pool.query(
                    `INSERT INTO employee_directory (id, user_id, first_name, last_name, department)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (id) DO UPDATE
                     SET user_id = EXCLUDED.user_id,
                         first_name = EXCLUDED.first_name,
                         last_name = EXCLUDED.last_name,
                         department = EXCLUDED.department,
                         updated_at = now()`,
                    [e.id, e.userId, e.firstName ?? null, e.lastName ?? null, e.department ?? null]
                );
                upserted += 1;
            }
            res.json({ upserted });
        } catch (err) {
            next(err);
        }
    });

    // DELETE /v1/internal/employee-directory/:id — drop a stale row.
    router.delete('/employee-directory/:id(\\d+)', async (req, res, next) => {
        try {
            const { rowCount } = await pool.query(`DELETE FROM employee_directory WHERE id = $1`, [
                Number(req.params.id)
            ]);
            if (!rowCount) throw httpError(404, 'Directory row not found');
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    });

    // ---- DSAR (data-subject access/erasure) — service-token only. ----
    // POST /v1/internal/dsar-export — tickets (+comments/history), expenses
    // (+items/approvals), asset assignments and the subject's own survey
    // answers (matched via the respondent hash — the only forward path).
    router.post('/dsar-export', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const employeeId = await resolveEmployeeId(pool, parsed.data);
            if (employeeId == null) {
                res.json({ found: false, reason: 'employee_unresolved' });
                return;
            }

            const { rows: tickets } = await pool.query(
                'SELECT * FROM tickets WHERE employee_id = $1 ORDER BY created_at',
                [employeeId]
            );
            const ticketIds = tickets.map((t: Record<string, unknown>) => t['id']);
            const { rows: comments } =
                ticketIds.length > 0
                    ? await pool.query('SELECT * FROM ticket_comments WHERE ticket_id = ANY($1)', [ticketIds])
                    : { rows: [] };
            const { rows: history } =
                ticketIds.length > 0
                    ? await pool.query('SELECT * FROM ticket_status_history WHERE ticket_id = ANY($1)', [ticketIds])
                    : { rows: [] };

            const { rows: reports } = await pool.query(
                'SELECT * FROM expense_reports WHERE employee_id = $1 ORDER BY created_at',
                [employeeId]
            );
            const reportIds = reports.map((r: Record<string, unknown>) => r['id']);
            const { rows: items } =
                reportIds.length > 0
                    ? await pool.query('SELECT * FROM expense_items WHERE report_id = ANY($1)', [reportIds])
                    : { rows: [] };
            const { rows: approvals } =
                reportIds.length > 0
                    ? await pool.query('SELECT * FROM expense_approvals WHERE report_id = ANY($1)', [reportIds])
                    : { rows: [] };

            const { rows: assignments } = await pool.query(
                'SELECT * FROM asset_assignments WHERE employee_id = $1 ORDER BY assigned_at',
                [employeeId]
            );

            // Pseudonymous survey responses — recompute the respondent hash
            // for each survey to locate this subject's submissions.
            const surveys = await surveyIds(pool);
            const surveyResponses: unknown[] = [];
            for (const surveyId of surveys) {
                const hash = respondentHash(config, surveyId, employeeId);
                const { rows } = await pool.query(
                    `SELECT id, survey_id, respondent_group, answers, submitted_at
                       FROM survey_responses WHERE survey_id = $1 AND respondent_hash = $2`,
                    [surveyId, hash]
                );
                for (const r of rows) {
                    const { rows: health } = await pool.query(
                        'SELECT answers FROM survey_health_answers WHERE response_id = $1',
                        [(r as Record<string, unknown>)['id']]
                    );
                    surveyResponses.push({ ...r, health_answers: health[0]?.['answers'] ?? null });
                }
            }

            res.json({
                found: true,
                employee_id: employeeId,
                tickets,
                ticket_comments: comments,
                ticket_status_history: history,
                expense_reports: reports,
                expense_items: items,
                expense_approvals: approvals,
                asset_assignments: assignments,
                survey_responses: surveyResponses
            });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/internal/dsar-erase — delete everything keyed by (or hash-
    // linked to) the employee_id, including the employee_directory mapping
    // itself. Idempotent: a re-run deletes empty sets and still returns
    // erased:true with zero counts.
    router.post('/dsar-erase', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const employeeId = await resolveEmployeeId(pool, parsed.data);
            if (employeeId == null) {
                res.json({ erased: false, detail: { reason: 'employee_unresolved' } });
                return;
            }

            const detail = await withTransaction(pool, async (client) => {
                // Survey responses first (health_answers cascade on response
                // delete; survey_health_audit rows keep only a dangling
                // response_id — no personal data).
                let surveyResponses = 0;
                for (const surveyId of await surveyIds(client)) {
                    const hash = respondentHash(config, surveyId, employeeId);
                    const { rowCount } = await client.query(
                        'DELETE FROM survey_responses WHERE survey_id = $1 AND respondent_hash = $2',
                        [surveyId, hash]
                    );
                    surveyResponses += rowCount ?? 0;
                }

                const { rowCount: comments } = await client.query(
                    `DELETE FROM ticket_comments WHERE ticket_id IN
                        (SELECT id FROM tickets WHERE employee_id = $1)`,
                    [employeeId]
                );
                const { rowCount: history } = await client.query(
                    `DELETE FROM ticket_status_history WHERE ticket_id IN
                        (SELECT id FROM tickets WHERE employee_id = $1)`,
                    [employeeId]
                );
                const { rowCount: tickets } = await client.query('DELETE FROM tickets WHERE employee_id = $1', [
                    employeeId
                ]);

                const { rowCount: items } = await client.query(
                    `DELETE FROM expense_items WHERE report_id IN
                        (SELECT id FROM expense_reports WHERE employee_id = $1)`,
                    [employeeId]
                );
                const { rowCount: approvals } = await client.query(
                    `DELETE FROM expense_approvals WHERE report_id IN
                        (SELECT id FROM expense_reports WHERE employee_id = $1)`,
                    [employeeId]
                );
                const { rowCount: reports } = await client.query('DELETE FROM expense_reports WHERE employee_id = $1', [
                    employeeId
                ]);

                const { rowCount: assignments } = await client.query(
                    'DELETE FROM asset_assignments WHERE employee_id = $1',
                    [employeeId]
                );
                const { rowCount: directory } = await client.query('DELETE FROM employee_directory WHERE id = $1', [
                    employeeId
                ]);

                return {
                    employeeId,
                    surveyResponses,
                    ticketComments: comments ?? 0,
                    ticketStatusHistory: history ?? 0,
                    tickets: tickets ?? 0,
                    expenseItems: items ?? 0,
                    expenseApprovals: approvals ?? 0,
                    expenseReports: reports ?? 0,
                    assetAssignments: assignments ?? 0,
                    directoryRows: directory ?? 0
                };
            });

            res.json({ erased: true, detail });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
