import { createHmac } from 'node:crypto';
import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import { enqueueEvent, flushOutbox, type EventPublisher } from '../events.js';
import { requireEmployee, requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction, type Queryable } from '../db.js';

export interface SurveysDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const idParam = z.coerce.number().int().positive();
function parseId(raw: string | undefined, what = 'id'): number {
    const parsed = idParam.safeParse(raw);
    if (!parsed.success) throw httpError(400, `Invalid ${what}`);
    return parsed.data;
}

const questionSchema = z
    .object({
        dimension: z.string().min(1).max(100),
        text: z.string().min(1).max(2000),
        scale: z.number().int().min(2).max(10).default(5),
        // Answers to health-related questions (medical risk factors /
        // psicosocial) are stored in survey_health_answers — a separate
        // table whose every read/write is audit-logged.
        healthRelated: z.boolean().default(false)
    })
    .strict();

const createSchema = z
    .object({
        title: z.string().min(1).max(300),
        type: z.enum(['nom035', 'climate']),
        opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
        closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
        questions: z.array(questionSchema).min(1).max(200)
    })
    .strict();

const respondSchema = z
    .object({
        // { "<questionId>": <answer 1..scale> }
        answers: z.record(z.string().regex(/^\d+$/), z.number().int().min(1).max(10))
    })
    .strict();

/**
 * Pseudonymous respondent key: HMAC-SHA256 over '<surveyId>:<employeeId>'
 * keyed by SURVEY_RESPONDENT_SALT (falling back to SERVICE_AUTH_TOKEN).
 * The raw employee_id is NEVER stored on survey_responses.
 */
export function respondentHash(config: ServiceConfig, surveyId: number, employeeId: number): string {
    const key = config.SURVEY_RESPONDENT_SALT ?? config.SERVICE_AUTH_TOKEN;
    return createHmac('sha256', key).update(`${surveyId}:${employeeId}`).digest('hex');
}

interface AggCell {
    grp: string;
    dimension: string;
    respondents: number;
    avg_score: number | null;
}

export interface AggResult {
    group: string;
    dimension: string;
    respondents?: number;
    avgScore?: number | null;
    suppressed?: boolean;
    reason?: string;
}

/**
 * k-anonymity: any (group, dimension) cell with fewer than minK respondents
 * is suppressed — the API returns { suppressed: true, reason: 'k<minK' }
 * with HTTP 200 instead of the aggregate. This is the ONLY shape in which
 * survey data leaves the service for HR callers.
 */
export function applyKAnonymity(cells: AggCell[], minK: number): AggResult[] {
    return cells.map((c) => {
        if (c.respondents < minK) {
            return { group: c.grp, dimension: c.dimension, suppressed: true, reason: `k<${minK}` };
        }
        return {
            group: c.grp,
            dimension: c.dimension,
            respondents: c.respondents,
            avgScore: c.avg_score != null ? Number(c.avg_score) : null
        };
    });
}

/** Record a read/write of survey_health_answers — every access is audited. */
async function auditHealth(
    db: Queryable,
    responseIds: number[],
    action: 'read' | 'write',
    actor: string
): Promise<void> {
    for (const responseId of responseIds) {
        await db.query(`INSERT INTO survey_health_audit (response_id, action, actor) VALUES ($1, $2, $3)`, [
            responseId,
            action,
            actor
        ]);
    }
}

/**
 * Per-(group, dimension) averages across both answer stores. Reading the
 * health store appends 'read' rows to survey_health_audit.
 */
async function computeAggregates(db: Queryable, surveyId: number, auditActor: string): Promise<AggCell[]> {
    const { rows } = await db.query(
        `SELECT grp, dimension, count(*)::int AS respondents, avg(score) AS avg_score
         FROM (
             SELECT COALESCE(r.respondent_group, '_all') AS grp, q.dimension,
                    (r.answers ->> q.id::text)::numeric AS score
             FROM survey_responses r
             JOIN survey_questions q
               ON q.survey_id = r.survey_id AND q.health_related = false
             WHERE r.survey_id = $1 AND r.answers ? (q.id::text)
             UNION ALL
             SELECT COALESCE(r.respondent_group, '_all'), q.dimension,
                    (h.answers ->> q.id::text)::numeric
             FROM survey_responses r
             JOIN survey_health_answers h ON h.response_id = r.id
             JOIN survey_questions q
               ON q.survey_id = r.survey_id AND q.health_related = true
             WHERE r.survey_id = $1 AND h.answers ? (q.id::text)
         ) s
         WHERE score IS NOT NULL
         GROUP BY grp, dimension`,
        [surveyId]
    );
    // Audit: the aggregation read the health-answer store.
    const { rows: healthRows } = await db.query(
        `SELECT h.response_id FROM survey_health_answers h
         JOIN survey_responses r ON r.id = h.response_id
         WHERE r.survey_id = $1`,
        [surveyId]
    );
    if (healthRows.length > 0) {
        await auditHealth(
            db,
            healthRows.map((r) => Number(r.response_id)),
            'read',
            auditActor
        );
    }
    return rows.map((r) => ({
        grp: String(r.grp),
        dimension: String(r.dimension),
        respondents: Number(r.respondents),
        avg_score: r.avg_score != null ? Number(r.avg_score) : null
    }));
}

function rowToSurvey(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        title: row.title,
        type: row.type,
        status: row.status,
        opensAt: row.opens_at ?? null,
        closesAt: row.closes_at ?? null,
        responseCount: row.response_count != null ? Number(row.response_count) : undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function rowToQuestion(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        surveyId: Number(row.survey_id),
        dimension: row.dimension,
        text: row.text,
        scale: Number(row.scale),
        healthRelated: row.health_related === true,
        position: Number(row.position)
    };
}

function auditActor(req: Request): string {
    return req.caller?.kind === 'service' ? 'service:aggregate' : `hr:${req.user?.userId ?? 'unknown'}:aggregate`;
}

export function surveysRouter(deps: SurveysDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();
    const employee = requireEmployee(pool);
    const hr = [serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR];
    const minK = config.SURVEY_MIN_GROUP_SIZE;

    // ------------------------------------------------------------------
    // Employee self-service
    // ------------------------------------------------------------------

    // GET /v1/surveys/open — currently open surveys, questions included so
    // the client can render the form.
    router.get('/open', employee, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT s.* FROM surveys s
                 WHERE s.status = 'open'
                   AND (s.opens_at IS NULL OR s.opens_at <= now())
                   AND (s.closes_at IS NULL OR s.closes_at > now())
                 ORDER BY s.id`
            );
            const out = [];
            for (const s of rows) {
                const { rows: qs } = await pool.query(
                    `SELECT * FROM survey_questions WHERE survey_id = $1 ORDER BY position, id`,
                    [s.id]
                );
                // Whether the caller already responded (own status only —
                // revealed via the caller's own hash, never a list of hashes).
                const { rows: mine } = await pool.query(
                    `SELECT 1 FROM survey_responses WHERE survey_id = $1 AND respondent_hash = $2`,
                    [s.id, respondentHash(config, Number(s.id), req.employeeId!)]
                );
                out.push({
                    ...rowToSurvey(s),
                    questions: qs.map(rowToQuestion),
                    answered: mine.length > 0
                });
            }
            res.json(out);
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/surveys/:id/my-response — the caller's own submission for one
    // survey (404 when unanswered). Employees may see ONLY their own answers.
    router.get('/:id(\\d+)/my-response', employee, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'survey id');
            const hash = respondentHash(config, id, req.employeeId!);
            const { rows } = await pool.query(
                `SELECT * FROM survey_responses WHERE survey_id = $1 AND respondent_hash = $2`,
                [id, hash]
            );
            if (!rows[0]) throw httpError(404, 'No response submitted for this survey');
            const row = rows[0];
            // Health answers are included for the owner only, and the read is
            // audit-logged like every access to survey_health_answers.
            const { rows: health } = await pool.query(
                `SELECT answers FROM survey_health_answers WHERE response_id = $1`,
                [row.id]
            );
            if (health[0]) {
                await auditHealth(pool, [Number(row.id)], 'read', `employee:${req.user!.userId}`);
            }
            res.json({
                surveyId: id,
                submittedAt: row.submitted_at,
                answers: { ...(row.answers as object), ...((health[0]?.answers as object) ?? {}) }
            });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/surveys/:id/respond — submit answers. One response per
    // employee per survey (unique respondent_hash → 409 on duplicates).
    // Answers to health_related questions are split into
    // survey_health_answers with an audit 'write' row.
    router.post('/:id(\\d+)/respond', employee, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'survey id');
            const parsed = respondSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid response payload', parsed.error.issues);
            const answers = parsed.data.answers;
            if (Object.keys(answers).length === 0) throw httpError(400, 'At least one answer is required');
            const employeeId = req.employeeId!;
            const hash = respondentHash(config, id, employeeId);

            const result = await withTransaction(pool, async (client) => {
                const { rows: surveyRows } = await client.query(`SELECT * FROM surveys WHERE id = $1 FOR UPDATE`, [id]);
                const survey = surveyRows[0];
                if (!survey) throw httpError(404, 'Survey not found');
                if (survey.status !== 'open') {
                    throw httpError(409, `Survey is ${survey.status} — responses are only accepted while open`);
                }

                const { rows: questions } = await client.query(
                    `SELECT id, scale, health_related FROM survey_questions WHERE survey_id = $1`,
                    [id]
                );
                const byId = new Map(questions.map((q) => [Number(q.id), q]));
                const regular: Record<string, number> = {};
                const health: Record<string, number> = {};
                for (const [qid, value] of Object.entries(answers)) {
                    const q = byId.get(Number(qid));
                    if (!q) throw httpError(400, `Answer references question ${qid} which is not part of this survey`);
                    if (value > Number(q.scale)) {
                        throw httpError(400, `Answer for question ${qid} exceeds scale ${q.scale}`);
                    }
                    if (q.health_related) health[qid] = value;
                    else regular[qid] = value;
                }

                // Department/group snapshot for k-anonymised aggregation —
                // taken from the directory at submit time, never reversible
                // to an employee_id.
                const { rows: dir } = await client.query(`SELECT department FROM employee_directory WHERE id = $1`, [
                    employeeId
                ]);
                const group = dir[0]?.department ?? null;

                let response;
                try {
                    ({
                        rows: [response]
                    } = await client.query(
                        `INSERT INTO survey_responses (survey_id, respondent_hash, respondent_group, answers)
                         VALUES ($1, $2, $3, $4) RETURNING *`,
                        [id, hash, group, JSON.stringify(regular)]
                    ));
                } catch (err) {
                    if ((err as { code?: string }).code === '23505') {
                        throw httpError(409, 'You have already responded to this survey');
                    }
                    throw err;
                }

                if (Object.keys(health).length > 0) {
                    await client.query(`INSERT INTO survey_health_answers (response_id, answers) VALUES ($1, $2)`, [
                        response.id,
                        JSON.stringify(health)
                    ]);
                    await auditHealth(client, [Number(response.id)], 'write', `employee:${req.user!.userId}`);
                }
                return response;
            });

            res.status(201).json({ surveyId: id, submittedAt: result.submitted_at });
        } catch (err) {
            next(err);
        }
    });

    // ------------------------------------------------------------------
    // HR management — strictly role 'hr' (admins get 403). HR sees survey
    // definitions, response COUNTS and k-anonymised aggregates only —
    // never individual survey_responses rows.
    // ------------------------------------------------------------------

    // POST /v1/surveys — create a draft survey with its questions.
    router.post('/', ...hr, async (req, res, next) => {
        try {
            const parsed = createSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid survey payload', parsed.error.issues);
            const data = parsed.data;

            const survey = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO surveys (title, type, opens_at, closes_at, created_by)
                     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                    [data.title, data.type, data.opensAt ?? null, data.closesAt ?? null, req.user?.userId ?? null]
                );
                const s = rows[0];
                for (const [i, q] of data.questions.entries()) {
                    await client.query(
                        `INSERT INTO survey_questions (survey_id, dimension, text, scale, health_related, position)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [s.id, q.dimension, q.text, q.scale, q.healthRelated, i]
                    );
                }
                return s;
            });

            const { rows: qs } = await pool.query(
                `SELECT * FROM survey_questions WHERE survey_id = $1 ORDER BY position, id`,
                [survey.id]
            );
            res.status(201).json({ ...rowToSurvey(survey), questions: qs.map(rowToQuestion) });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/surveys — list with response counts (never answers).
    router.get('/', ...hr, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT s.*, (SELECT count(*) FROM survey_responses r WHERE r.survey_id = s.id)::int AS response_count
                 FROM surveys s ORDER BY s.created_at DESC`
            );
            res.json(rows.map(rowToSurvey));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/surveys/:id — definition + questions + response count.
    router.get('/:id(\\d+)', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'survey id');
            const { rows } = await pool.query(
                `SELECT s.*, (SELECT count(*) FROM survey_responses r WHERE r.survey_id = s.id)::int AS response_count
                 FROM surveys s WHERE s.id = $1`,
                [id]
            );
            if (!rows[0]) throw httpError(404, 'Survey not found');
            const { rows: qs } = await pool.query(
                `SELECT * FROM survey_questions WHERE survey_id = $1 ORDER BY position, id`,
                [id]
            );
            res.json({ ...rowToSurvey(rows[0]), questions: qs.map(rowToQuestion) });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/surveys/:id/open — draft → open. Publishes survey_opened.
    router.post('/:id(\\d+)/open', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'survey id');
            const row = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM surveys WHERE id = $1 FOR UPDATE`, [id]);
                const survey = rows[0];
                if (!survey) throw httpError(404, 'Survey not found');
                if (survey.status !== 'draft') {
                    throw httpError(409, `Survey is ${survey.status} — only drafts can be opened`);
                }
                const { rows: updated } = await client.query(
                    `UPDATE surveys SET status = 'open', opens_at = COALESCE(opens_at, now()), updated_at = now()
                     WHERE id = $1 RETURNING *`,
                    [id]
                );
                await enqueueEvent(
                    client,
                    'strafor.services.survey_opened',
                    {
                        surveyId: id,
                        type: survey.type,
                        opensAt: updated[0].opens_at ? new Date(updated[0].opens_at).toISOString() : null,
                        closesAt: survey.closes_at ? new Date(survey.closes_at).toISOString() : null
                    },
                    req.correlationId
                );
                return updated[0];
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);
            res.json(rowToSurvey(row));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/surveys/:id/close — open → closed; computes the
    // k-anonymised aggregates into survey_results_agg. Publishes
    // survey_closed.
    router.post('/:id(\\d+)/close', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'survey id');
            const row = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM surveys WHERE id = $1 FOR UPDATE`, [id]);
                const survey = rows[0];
                if (!survey) throw httpError(404, 'Survey not found');
                if (survey.status !== 'open') {
                    throw httpError(409, `Survey is ${survey.status} — only open surveys can be closed`);
                }
                const cells = await computeAggregates(client, id, auditActor(req));
                await client.query(`DELETE FROM survey_results_agg WHERE survey_id = $1`, [id]);
                for (const c of cells) {
                    await client.query(
                        `INSERT INTO survey_results_agg (survey_id, respondent_group, dimension, respondents, avg_score, suppressed)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [
                            id,
                            c.grp,
                            c.dimension,
                            c.respondents,
                            c.respondents < minK ? null : c.avg_score,
                            c.respondents < minK
                        ]
                    );
                }
                const { rows: counts } = await client.query(
                    `SELECT count(*)::int AS n FROM survey_responses WHERE survey_id = $1`,
                    [id]
                );
                const respondents = Number(counts[0]?.n ?? 0);
                const { rows: updated } = await client.query(
                    `UPDATE surveys SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING *`,
                    [id]
                );
                await enqueueEvent(
                    client,
                    'strafor.services.survey_closed',
                    { surveyId: id, type: survey.type, respondents },
                    req.correlationId
                );
                return updated[0];
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);
            res.json(rowToSurvey(row));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/surveys/:id/results — k-anonymised aggregates ONLY. Closed
    // surveys read survey_results_agg; open/draft surveys compute on
    // demand. Cells under the threshold return
    // { suppressed: true, reason: 'k<5' } with HTTP 200. Individual
    // responses are NEVER exposed.
    router.get('/:id(\\d+)/results', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'survey id');
            const { rows: surveyRows } = await pool.query(`SELECT * FROM surveys WHERE id = $1`, [id]);
            const survey = surveyRows[0];
            if (!survey) throw httpError(404, 'Survey not found');

            const { rows: counts } = await pool.query(
                `SELECT count(*)::int AS n FROM survey_responses WHERE survey_id = $1`,
                [id]
            );
            const respondents = Number(counts[0]?.n ?? 0);

            let results: AggResult[];
            if (survey.status === 'closed') {
                const { rows } = await pool.query(
                    `SELECT respondent_group AS grp, dimension, respondents, avg_score, suppressed
                     FROM survey_results_agg WHERE survey_id = $1
                     ORDER BY respondent_group, dimension`,
                    [id]
                );
                results = rows.map((r) =>
                    r.suppressed
                        ? { group: r.grp, dimension: r.dimension, suppressed: true, reason: `k<${minK}` }
                        : {
                              group: r.grp,
                              dimension: r.dimension,
                              respondents: Number(r.respondents),
                              avgScore: r.avg_score != null ? Number(r.avg_score) : null
                          }
                );
            } else {
                const cells = await computeAggregates(pool, id, auditActor(req));
                results = applyKAnonymity(cells, minK);
            }

            res.json({
                surveyId: id,
                status: survey.status,
                respondents,
                minGroupSize: minK,
                results
            });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
