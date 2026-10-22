import { Router } from 'express';
import { httpError } from '@strafor/node-common';
import { withTransaction } from '../db.js';
import * as Vacancy from '../models/vacancy.js';
import * as Application from '../models/application.js';
import * as Interview from '../models/interview.js';
import * as Skill from '../models/skill.js';
import { callService } from '../serviceClient.js';
import { enqueueEvent, flushOutbox } from '../events.js';
import { serviceOrHrAuth } from '../auth.js';
import { validate } from '../validate.js';
import * as schemas from '../schemas.js';
import { interviewScheduledPayload } from '../payloads.js';
import type { ServiceDeps } from '../deps.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function vacancyPayload(vacancy: Row) {
    return {
        id: vacancy.id ?? vacancy._id,
        title: vacancy.title,
        description: vacancy.description,
        requirements: vacancy.requirements,
        skills_required: Array.isArray(vacancy.skills_required) ? vacancy.skills_required : [],
        experience_level: vacancy.experience_level,
        location: vacancy.location,
        remote_option: vacancy.remote_option,
        salary_min: vacancy.salary_min,
        salary_max: vacancy.salary_max,
        application_deadline: vacancy.application_deadline
    };
}

function candidatePayload(candidate: Row) {
    return {
        id: candidate.id ?? candidate._id,
        skills: candidate.skills || '',
        experience: candidate.experience,
        education: candidate.education,
        location: candidate.location,
        current_position: candidate.current_position
    };
}

export function vacanciesRouter(deps: ServiceDeps): Router {
    const { pool, config, publisher, log } = deps;
    const hr = serviceOrHrAuth(config.SERVICE_AUTH_TOKEN);
    const router = Router();

    // Call /v1/vacancies/:id/rank. The service may defer large batches to a
    // job — poll /v1/jobs/:id until it resolves (bounded ~12s) and return
    // its result.
    async function rankViaService(vacancy: Row, candidates: Row[], correlationId?: string) {
        const vacancyId = vacancy.id ?? vacancy._id;
        const initial = (await callService(config.AI_SERVICE_URL, `/v1/vacancies/${vacancyId}/rank`, {
            method: 'POST',
            timeout: 15000,
            correlationId,
            serviceToken: config.SERVICE_AUTH_TOKEN,
            body: {
                vacancy: vacancyPayload(vacancy),
                candidates: candidates.map(candidatePayload)
            }
        })) as Row | null;
        if (initial && Array.isArray(initial.results)) {
            return initial;
        }
        if (!initial || !initial.job_id) {
            throw new Error('unexpected rank response shape');
        }
        for (let attempt = 0; attempt < 24; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const job = (await callService(config.AI_SERVICE_URL, `/v1/jobs/${initial.job_id}`, {
                method: 'GET',
                timeout: 5000,
                correlationId,
                serviceToken: config.SERVICE_AUTH_TOKEN
            })) as Row;
            if (job.status === 'done') return job.result;
            if (job.status === 'failed') throw new Error(`rank job failed: ${job.error}`);
        }
        throw new Error('rank job timed out');
    }

    // GET /v1/vacancies — PUBLIC anonymous careers listing (no auth; the
    // gateway lets anonymous GET /api/v1/vacancies through — see
    // isPublicV1Path). Optional filters preserved from the monolith.
    router.get('/', async (req, res, next) => {
        try {
            const { department, location, type, salaryMin, salaryMax, skills, search } = req.query;
            const vacancies = await Vacancy.find(pool, {
                department: department as string | undefined,
                location: location as string | undefined,
                type: type as string | undefined,
                salaryMin,
                salaryMax,
                skills: skills as string | string[] | undefined,
                search: search as string | undefined
            });
            res.json(vacancies);
        } catch (error) {
            next(error);
        }
    });

    // POST /v1/vacancies — create (HR only)
    router.post('/', hr, validate({ body: schemas.vacancyCreateBody }), async (req, res, next) => {
        try {
            const userId = req.user?.userId ?? null;
            const vacancyData: Vacancy.VacancyCreateData = {
                ...req.body,
                company: 'Tech Mahindra',
                status: 'Active',
                created_by_user_id: userId,
                benefits: Array.isArray(req.body.benefits) ? req.body.benefits : [],
                remote_option: req.body.remote_option || false,
                application_deadline: req.body.application_deadline || null,
                external_postings: {
                    linkedin: req.body.external_postings?.linkedin || false,
                    occ: req.body.external_postings?.occ || false
                }
            };

            const vacancy = await withTransaction(pool, async (client) => {
                const created = await Vacancy.create(client, vacancyData);
                const eventPayload = {
                    vacancyId: created.id,
                    title: created.title,
                    department: created.department,
                    location: created.location,
                    type: created.type,
                    ...(created.experience_level ? { experienceLevel: created.experience_level } : {}),
                    skillsRequired: Array.isArray(created.skills_required) ? created.skills_required : [],
                    ...(userId ? { publishedBy: userId } : {})
                };
                await enqueueEvent(client, 'strafor.recruitment.vacancy_published', eventPayload, req.correlationId);
                // Legacy type — ai-matching/analytics consume it during the transition.
                await enqueueEvent(client, 'strafor.vacancy.published', eventPayload, req.correlationId);
                return created;
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            res.status(201).json(vacancy);
        } catch (error) {
            next(error);
        }
    });

    // GET /v1/vacancies/:id — single vacancy detail (HR only; the public
    // careers page reads the open list instead — see GET /v1/vacancies).
    router.get('/:id', hr, validate({ params: schemas.idParam }), async (req, res, next) => {
        try {
            const vacancy = await Vacancy.findById(pool, req.params.id);
            if (!vacancy) {
                throw httpError(404, 'Vacancy not found');
            }
            res.json(vacancy);
        } catch (error) {
            next(error);
        }
    });

    // Column mapping for PUT — request keys → columns. Never trust req.body
    // keys: only keys in this map may be written, everything else is stripped
    // by zod anyway (defense in depth).
    const VACANCY_UPDATE_COLUMNS: Record<string, string> = {
        title: 'title',
        department: 'department',
        location: 'location',
        type: 'type',
        description: 'description',
        requirements: 'requirements',
        responsibilities: 'responsibilities',
        skills_required: 'skills_required',
        experience_level: 'experience_level',
        benefits: 'benefits',
        remote_option: 'remote_option',
        application_deadline: 'application_deadline',
        status: 'status',
        external_postings: 'external_postings'
    };

    // PUT /v1/vacancies/:id — partial update (HR only). Whitelisted column
    // writes inside one transaction; when skills_required changes,
    // vacancy_skills is re-synced in the same tx so the matcher never sees a
    // stale taxonomy.
    router.put(
        '/:id',
        hr,
        validate({ params: schemas.idParam, body: schemas.vacancyUpdateBody }),
        async (req, res, next) => {
            try {
                const vacancyId = req.params.id;
                const body = req.body as Row;

                const updated = await withTransaction(pool, async (client) => {
                    const { rows: found } = await client.query(
                        'SELECT id FROM vacancies WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
                        [vacancyId]
                    );
                    if (!found[0]) return null;

                    const sets: string[] = [];
                    const values: unknown[] = [vacancyId];
                    const push = (column: string, value: unknown) => {
                        values.push(value);
                        sets.push(`${column} = $${values.length}`);
                    };

                    for (const [key, column] of Object.entries(VACANCY_UPDATE_COLUMNS)) {
                        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
                        if (key === 'external_postings') {
                            push(column, JSON.stringify(body[key] ?? {}));
                        } else {
                            push(column, body[key]);
                        }
                    }
                    if (Object.prototype.hasOwnProperty.call(body, 'salary_range')) {
                        const range = body.salary_range;
                        push('salary_min', range && range.min != null ? Number(range.min) : null);
                        push('salary_max', range && range.max != null ? Number(range.max) : null);
                        push('salary_currency', range ? range.currency || null : null);
                    }

                    if (sets.length > 0) {
                        await client.query(
                            `UPDATE vacancies SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
                            values
                        );
                    }

                    if (Array.isArray(body.skills_required)) {
                        await Skill.syncVacancySkills(client, vacancyId as unknown as number, body.skills_required);
                    }

                    const eventPayload = {
                        vacancyId: Number(vacancyId),
                        changedFields: Object.keys(body),
                        vacancy: body
                    };
                    await enqueueEvent(client, 'strafor.recruitment.vacancy_updated', eventPayload, req.correlationId);
                    await enqueueEvent(client, 'strafor.vacancy.updated', eventPayload, req.correlationId);
                    return true;
                });

                if (!updated) {
                    throw httpError(404, 'Vacancy not found');
                }
                await flushOutbox(pool, publisher, log).catch(() => 0);

                // Re-read via the model so the wire shape (salary_range synth,
                // created_by join) matches every other endpoint.
                const vacancy = await Vacancy.findById(pool, vacancyId);
                res.json(vacancy);
            } catch (error) {
                next(error);
            }
        }
    );

    // GET /v1/vacancies/:id/top-candidates (HR only — exposes candidate PII)
    router.get('/:id/top-candidates', hr, async (req, res, next) => {
        try {
            const vacancy = await Vacancy.findById(pool, req.params.id);
            if (!vacancy) {
                throw httpError(404, 'Vacancy not found');
            }

            const candidates = await Application.findForVacancy(pool, req.params.id);

            let ranked;
            try {
                ranked = await rankViaService(vacancy, candidates, req.correlationId);
            } catch (err) {
                log.error({ err: err instanceof Error ? err.message : err }, 'AI ranking service failed');
                throw httpError(503, 'AI service unavailable');
            }

            const byId = new Map(candidates.map((c) => [String(c.id ?? c._id), c]));
            const topCandidates: Row[] = [];
            for (const r of ranked.results || []) {
                if (typeof r.score !== 'number' || r.score < config.AI_MIN_MATCH_SCORE) continue;
                const candidate = byId.get(String(r.candidate_id));
                if (!candidate) continue;
                topCandidates.push({
                    ...candidate,
                    match_score: r.score,
                    match_details: {
                        confidence: r.score,
                        match_level: r.match_level,
                        recommendation: r.explanation?.recommendation || '',
                        score_breakdown: r.subscores || {},
                        red_flags: r.red_flags || [],
                        source: ranked.source
                    }
                });
            }

            res.json(topCandidates);
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/vacancies/:id/candidates (HR only — exposes candidate PII)
    router.get('/:id/candidates', hr, async (req, res, next) => {
        try {
            const { id } = req.params;

            const candidates = await Application.findForVacancy(pool, id);

            const vacancy = await Vacancy.findById(pool, id);
            if (!vacancy) {
                throw httpError(404, 'Vacancy not found');
            }

            // Analyze and update candidates missing ai_feedback_analysis.match_score.
            // One batch rank call replaces the old per-candidate inline scoring.
            const missing = candidates.filter(
                (c) => !c.ai_feedback_analysis || typeof c.ai_feedback_analysis.match_score !== 'number'
            );
            if (missing.length > 0) {
                try {
                    const ranked = await rankViaService(vacancy, missing, req.correlationId);
                    const byId = new Map((ranked.results || []).map((r: Row) => [String(r.candidate_id), r]));
                    for (const candidate of missing) {
                        const r = byId.get(String(candidate.id ?? candidate._id)) as Row | undefined;
                        if (!r || typeof r.score !== 'number') continue;
                        candidate.ai_feedback_analysis = {
                            match_score: r.score,
                            match_level: r.match_level || 'Low Match',
                            recommendation: r.explanation?.recommendation || '',
                            summary: r.explanation?.summary || '',
                            generated_at: new Date()
                        };
                        await Application.updateById(pool, candidate.application_id, {
                            ai_feedback_analysis: candidate.ai_feedback_analysis
                        });
                    }
                } catch (e) {
                    // Best-effort enrichment — the list is still served without scores.
                    log.error({ err: e instanceof Error ? e.message : e }, 'AI ranking unavailable for candidate list');
                }
            }

            // No refetch needed — candidates are already updated in memory
            const candidatesWithFeedbackStatus = candidates.map((candidate) => ({
                ...candidate,
                needs_feedback: candidate.status === 'accepted' && !candidate.hiring_feedback
            }));

            res.json(candidatesWithFeedbackStatus);
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/vacancies/:id/applications — canonical applications list (HR
    // only). Same data as /:id/candidates but with the application as the
    // top-level resource and the candidate nested inside it.
    router.get('/:id/applications', hr, validate({ params: schemas.idParam }), async (req, res, next) => {
        try {
            const vacancy = await Vacancy.findById(pool, req.params.id);
            if (!vacancy) {
                throw httpError(404, 'Vacancy not found');
            }
            const applications = await Application.findDetailedByVacancy(pool, req.params.id);
            res.json(applications);
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/vacancies/:id/interviews — scheduled interviews for a vacancy
    // (HR only). Record-level GET/PUT live under /v1/interviews/:id.
    router.get('/:id/interviews', hr, validate({ params: schemas.idParam }), async (req, res, next) => {
        try {
            const vacancy = await Vacancy.findById(pool, req.params.id);
            if (!vacancy) {
                throw httpError(404, 'Vacancy not found');
            }
            const interviews = await Interview.findByVacancy(pool, req.params.id);
            res.json(interviews);
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/vacancies/:id/interviews — schedule an interview (HR only).
    // The interviewee is referenced by application_id (must belong to this
    // vacancy) or candidate_id (resolved to the latest application on this
    // vacancy). Enqueues strafor.interview.scheduled for notifications.
    router.post(
        '/:id/interviews',
        hr,
        validate({ params: schemas.idParam, body: schemas.interviewCreateBody }),
        async (req, res, next) => {
            try {
                const vacancy = await Vacancy.findById(pool, req.params.id);
                if (!vacancy) {
                    throw httpError(404, 'Vacancy not found');
                }
                const vacancyId = Number(req.params.id);
                const body = req.body as Row;

                const created = await withTransaction(pool, async (client) => {
                    let application: Row | null;
                    if (body.application_id != null) {
                        application = await Application.findById(client, body.application_id);
                        if (!application) {
                            throw httpError(404, 'Application not found');
                        }
                        if (Number(application.vacancy_id) !== vacancyId) {
                            throw httpError(400, 'Application does not belong to this vacancy');
                        }
                    } else {
                        application = await Application.resolveForCandidate(client, body.candidate_id, vacancyId);
                        if (!application) {
                            throw httpError(404, 'Application not found');
                        }
                    }

                    const interview = await Interview.create(client, {
                        application_id: application.id,
                        candidate_id: application.candidate_id,
                        vacancy_id: vacancyId,
                        scheduled_at: body.scheduled_at,
                        duration_minutes: body.duration_minutes,
                        interviewer_user_id: body.interviewer_user_id ?? null,
                        location_or_link: body.location_or_link ?? null,
                        notes: body.notes ?? null,
                        created_by: req.user?.userId ?? null
                    });

                    // Display refs for the notification payload — the event
                    // carries ids + names + the invite email only (no other
                    // PII on the bus).
                    const candidate =
                        (
                            await client.query('SELECT first_name, last_name, email FROM candidates WHERE id = $1', [
                                application.candidate_id
                            ])
                        ).rows[0] ?? {};
                    const interviewerName =
                        body.interviewer_user_id != null
                            ? ((
                                  await client.query(
                                      `SELECT first_name || ' ' || last_name AS name
                                       FROM users_projection WHERE id = $1`,
                                      [body.interviewer_user_id]
                                  )
                              ).rows[0]?.name ?? undefined)
                            : undefined;
                    const candidateName =
                        `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`.trim() || undefined;

                    await enqueueEvent(
                        client,
                        'strafor.interview.scheduled',
                        interviewScheduledPayload(interview, {
                            email: candidate.email ?? null,
                            name: candidateName ?? null,
                            vacancyTitle: vacancy.title ?? null,
                            interviewerName: interviewerName ?? null
                        }),
                        req.correlationId
                    );
                    return interview;
                });
                await flushOutbox(pool, publisher, log).catch(() => 0);

                res.status(201).json(created);
            } catch (err) {
                next(err);
            }
        }
    );

    // DELETE /v1/vacancies/:id (HR only — soft-deletes the vacancy and its
    // applications in one transaction; FKs are RESTRICT, nothing is removed)
    router.delete('/:id', hr, validate({ params: schemas.idParam }), async (req, res, next) => {
        try {
            const userId = req.user?.userId ?? undefined;
            const deletedVacancy = await withTransaction(pool, async (client) => {
                const v = await Vacancy.softDeleteById(client, req.params.id);
                if (v) {
                    const payload: Record<string, unknown> = {
                        vacancyId: v.id,
                        reason: 'deleted',
                        ...(userId ? { closedBy: userId } : {})
                    };
                    await enqueueEvent(client, 'strafor.recruitment.vacancy_closed', payload, req.correlationId);
                }
                return v;
            });
            if (!deletedVacancy) {
                throw httpError(404, 'Vacancy not found');
            }
            await flushOutbox(pool, publisher, log).catch(() => 0);
            res.json({ message: 'Vacancy and associated applications deleted successfully' });
        } catch (error) {
            next(error);
        }
    });

    return router;
}
