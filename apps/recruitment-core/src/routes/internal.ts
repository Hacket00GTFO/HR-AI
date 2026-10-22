import { Router } from 'express';
import { z } from 'zod';
import { httpError } from '@strafor/node-common';
import type { ServiceDeps } from '../deps.js';
import { requireService } from '../auth.js';
import { withTransaction } from '../db.js';

const upsertSchema = z
    .object({
        users: z
            .array(
                z
                    .object({
                        id: z.number().int().positive(),
                        firstName: z.string().max(100).nullable().optional(),
                        lastName: z.string().max(100).nullable().optional(),
                        email: z.string().email().max(255).nullable().optional()
                    })
                    .strict()
            )
            .min(1)
            .max(500)
    })
    .strict();

/**
 * DSAR fan-out request (apps/api utils/dsar.js). subjectKey is the primary
 * identifier — candidate email here; employee-domain services also accept
 * userId/employeeId when the caller has already resolved them.
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

/**
 * Internal-only routes — reachable exclusively with X-Service-Token, never
 * with user identity headers. Used by identity-auth/monolith sync jobs to
 * keep users_projection (display names for vacancies.created_by and
 * status-history changed_by) fresh until a strafor.identity.* consumer
 * exists. Mirrors hr-core's /v1/internal/users-projection.
 */
export function internalRouter(deps: ServiceDeps): Router {
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
                    `INSERT INTO users_projection (id, first_name, last_name, email)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (id) DO UPDATE
                     SET first_name = EXCLUDED.first_name,
                         last_name = EXCLUDED.last_name,
                         email = EXCLUDED.email,
                         updated_at = now()`,
                    [u.id, u.firstName ?? null, u.lastName ?? null, u.email ?? null]
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

    // ---- DSAR (GDPR/LFPDPPP data-subject requests) ----
    // Candidate-domain service: the subject key is the candidate EMAIL.
    // Called by the monolith's utils/dsar.js fan-out; service-token only.
    router.post('/dsar-export', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const email = (parsed.data.email ?? parsed.data.subjectKey).toLowerCase();

            const { rows: candidates } = await pool.query(
                `SELECT * FROM candidates WHERE lower(email) = $1 AND deleted_at IS NULL`,
                [email]
            );
            const candidate = candidates[0];
            if (!candidate) {
                res.json({ found: false, candidate: null });
                return;
            }

            const { rows: applications } = await pool.query(
                `SELECT a.*, v.title AS vacancy_title
                   FROM applications a LEFT JOIN vacancies v ON v.id = a.vacancy_id
                  WHERE a.candidate_id = $1 ORDER BY a.applied_at`,
                [candidate.id]
            );
            const { rows: history } = await pool.query(
                `SELECT h.* FROM application_status_history h
                   JOIN applications a ON a.id = h.application_id
                  WHERE a.candidate_id = $1 ORDER BY h.changed_at`,
                [candidate.id]
            );
            const { rows: skills } = await pool.query(
                `SELECT s.name FROM candidate_skills cs JOIN skills s ON s.id = cs.skill_id
                  WHERE cs.candidate_id = $1`,
                [candidate.id]
            );

            res.json({
                found: true,
                candidate,
                skills: skills.map((s: { name: string }) => s.name),
                applications,
                status_history: history
            });
        } catch (err) {
            next(err);
        }
    });

    // Erasure mirrors the monolith's anonymization: PII fields are stubbed and
    // the email is rewritten to a non-identifying placeholder so the unique
    // index is preserved. candidate_skills are deleted; application AI/HR
    // feedback is scrubbed; the application rows themselves stay (they are
    // the company's hiring record, no longer linked to an identifiable person).
    router.post('/dsar-erase', async (req, res, next) => {
        try {
            const parsed = dsarRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid DSAR payload', parsed.error.issues);
            const email = (parsed.data.email ?? parsed.data.subjectKey).toLowerCase();

            const { rows: candidates } = await pool.query(
                `SELECT * FROM candidates WHERE lower(email) = $1 AND deleted_at IS NULL`,
                [email]
            );
            const candidate = candidates[0];
            if (!candidate) {
                // Idempotent: a re-run after erasure finds no row under the
                // original email — that is still a successful no-op.
                res.json({ erased: false, detail: { reason: 'no_matching_candidate' } });
                return;
            }

            const detail = await withTransaction(pool, async (client) => {
                await client.query(
                    `UPDATE candidates SET
                        first_name = '[erased]', last_name = '[erased]',
                        email = $2, phone = '', linkedin = NULL,
                        experience = 0, education = '[erased]', location = '[erased]',
                        skills = '', resume = NULL, resume_document_id = NULL, current_position = NULL
                     WHERE id = $1`,
                    [candidate.id, `erased+${candidate.id}@erased.invalid`]
                );
                const { rowCount: apps } = await client.query(
                    `UPDATE applications SET hiring_feedback = NULL, ai_insights = NULL,
                        ai_feedback_analysis = NULL
                     WHERE candidate_id = $1`,
                    [candidate.id]
                );
                const { rowCount: skills } = await client.query(
                    'DELETE FROM candidate_skills WHERE candidate_id = $1',
                    [candidate.id]
                );
                return { candidateId: candidate.id, applicationsScrubbed: apps ?? 0, skillsRemoved: skills ?? 0 };
            });

            res.json({ erased: true, detail });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
