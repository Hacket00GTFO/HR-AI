const express = require('express');
const router = express.Router();
const db = require('../db');
const Vacancy = require('../models/Vacancy');
const Application = require('../models/Application');
const Skill = require('../models/Skill');
const audit = require('../utils/audit');
const outbox = require('../utils/outbox');
const { callService } = require('../utils/serviceClient');
const logger = require('../utils/logger');
const { isHR } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || null;
// Minimum score a candidate needs to appear in /top-candidates.
const AI_MIN_MATCH_SCORE = Number(process.env.AI_MIN_MATCH_SCORE ?? 0.35);

function vacancyPayload(vacancy) {
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

function candidatePayload(candidate) {
    return {
        id: candidate.id ?? candidate._id,
        skills: candidate.skills || '',
        experience: candidate.experience,
        education: candidate.education,
        location: candidate.location,
        current_position: candidate.current_position
    };
}

// Call /v1/vacancies/:id/rank. The service may defer large batches to a job —
// poll /v1/jobs/:id until it resolves (bounded ~12s) and return its result.
async function rankViaService(vacancy, candidates, correlationId) {
    const vacancyId = vacancy.id ?? vacancy._id;
    const initial = await callService(AI_SERVICE_URL, `/v1/vacancies/${vacancyId}/rank`, {
        method: 'POST',
        timeout: 15000,
        correlationId,
        body: {
            vacancy: vacancyPayload(vacancy),
            candidates: candidates.map(candidatePayload)
        }
    });
    if (initial && Array.isArray(initial.results)) {
        return initial;
    }
    if (!initial || !initial.job_id) {
        throw new Error('unexpected rank response shape');
    }
    for (let attempt = 0; attempt < 24; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const job = await callService(AI_SERVICE_URL, `/v1/jobs/${initial.job_id}`, {
            method: 'GET',
            timeout: 5000,
            correlationId
        });
        if (job.status === 'done') return job.result;
        if (job.status === 'failed') throw new Error(`rank job failed: ${job.error}`);
    }
    throw new Error('rank job timed out');
}

// GET /api/vacancies — list with optional filters
router.get('/', async (req, res) => {
    try {
        const { department, location, type, salaryMin, salaryMax, skills, search } = req.query;
        const vacancies = await Vacancy.find({ department, location, type, salaryMin, salaryMax, skills, search });
        res.json(vacancies);
    } catch (error) {
        logger.error('Error fetching vacancies:', error);
        res.status(500).json({ error: 'Error fetching vacancies' });
    }
});

// POST /api/vacancies — create (HR only)
router.post('/', isHR, validate({ body: schemas.vacancyCreateBody }), async (req, res) => {
    try {
        const vacancyData = {
            ...req.body,
            company: 'Tech Mahindra',
            status: 'Active',
            created_by_user_id: req.user.id,
            benefits: Array.isArray(req.body.benefits) ? req.body.benefits : [],
            remote_option: req.body.remote_option || false,
            application_deadline: req.body.application_deadline || null,
            external_postings: {
                linkedin: req.body.external_postings?.linkedin || false,
                occ: req.body.external_postings?.occ || false
            }
        };

        const vacancy = await Vacancy.create(vacancyData);

        if (req.body.external_postings) {
            if (req.body.external_postings.linkedin) logger.debug('LinkedIn posting requested');
            if (req.body.external_postings.occ) logger.debug('OCC Mundial posting requested');
        }

        await audit.record({
            actorId: req.user.id,
            action: 'vacancy.create',
            entity: 'vacancies',
            entityId: vacancy.id,
            metadata: { title: vacancy.title, department: vacancy.department }
        });

        res.status(201).json(vacancy);
    } catch (error) {
        logger.error('Error creating vacancy:', error);
        res.status(500).json({ error: 'Error creating vacancy' });
    }
});

// GET /api/vacancies/:id — single vacancy detail (HR only; the public careers
// page reads the open list instead — see GET /api/vacancies).
router.get('/:id', isHR, validate({ params: schemas.idParam }), async (req, res) => {
    try {
        const vacancy = await Vacancy.findById(req.params.id);
        if (!vacancy) {
            return res.status(404).json({ error: 'Vacancy not found' });
        }
        res.json(vacancy);
    } catch (error) {
        logger.error('Error fetching vacancy:', error);
        res.status(500).json({ error: 'Error fetching vacancy' });
    }
});

// Column mapping for PUT — request keys → columns. Never trust req.body keys:
// only keys in this map may be written, everything else is stripped by zod
// anyway (defense in depth).
const VACANCY_UPDATE_COLUMNS = {
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

// PUT /api/vacancies/:id — partial update (HR only). Whitelisted column
// writes inside one transaction; when skills_required changes, vacancy_skills
// is re-synced in the same tx so the matcher never sees a stale taxonomy.
router.put('/:id', isHR, validate({ params: schemas.idParam, body: schemas.vacancyUpdateBody }), async (req, res) => {
    try {
        const vacancyId = req.params.id;
        const body = req.body;

        const updated = await db.withTransaction(async (client) => {
            const { rows: found } = await client.query(
                'SELECT id FROM vacancies WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
                [vacancyId]
            );
            if (!found[0]) return null;

            const sets = [];
            const values = [vacancyId];
            const push = (column, value) => {
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
                await client.query(`UPDATE vacancies SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);
            }

            if (Array.isArray(body.skills_required)) {
                await Skill.syncVacancySkills(client, vacancyId, body.skills_required);
            }
            // Transactional outbox — strafor.recruitment.vacancy_updated.
            // changedFields mirrors the validated body keys; consumers merge
            // `vacancy` into their projection.
            await outbox.record(client, {
                aggregateType: 'vacancy',
                aggregateId: vacancyId,
                eventType: 'strafor.recruitment.vacancy_updated',
                payload: {
                    vacancyId: Number(vacancyId),
                    changedFields: Object.keys(body),
                    vacancy: body
                }
            });
            return true;
        });

        if (!updated) {
            return res.status(404).json({ error: 'Vacancy not found' });
        }

        await audit.record({
            actorId: req.user.id,
            action: 'vacancy.update',
            entity: 'vacancies',
            entityId: vacancyId,
            metadata: { fields: Object.keys(body) }
        });

        // Re-read via the model so the wire shape (salary_range synth,
        // created_by join) matches every other endpoint.
        const vacancy = await Vacancy.findById(vacancyId);
        res.json(vacancy);
    } catch (error) {
        logger.error('Error updating vacancy:', error);
        res.status(500).json({ error: 'Error updating vacancy' });
    }
});

// GET /api/vacancies/:id/top-candidates (HR only — exposes candidate PII)
router.get('/:id/top-candidates', isHR, async (req, res) => {
    try {
        const vacancy = await Vacancy.findById(req.params.id);
        if (!vacancy) {
            return res.status(404).json({ error: 'Vacancy not found' });
        }

        const candidates = await Application.findForVacancy(req.params.id);

        let ranked;
        try {
            ranked = await rankViaService(vacancy, candidates, req.headers['x-correlation-id']);
        } catch (err) {
            logger.error('AI ranking service failed:', err);
            return res.status(503).json({ error: 'AI service unavailable' });
        }

        const byId = new Map(candidates.map((c) => [String(c.id ?? c._id), c]));
        const topCandidates = [];
        for (const r of ranked.results || []) {
            if (typeof r.score !== 'number' || r.score < AI_MIN_MATCH_SCORE) continue;
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
        logger.error('Error fetching top candidates:', err);
        res.status(500).json({ error: 'Error fetching top candidates' });
    }
});

// GET /api/vacancies/:id/candidates (HR only — exposes candidate PII)
router.get('/:id/candidates', isHR, async (req, res) => {
    try {
        const { id } = req.params;

        const candidates = await Application.findForVacancy(id);

        const vacancy = await Vacancy.findById(id);
        if (!vacancy) {
            return res.status(404).json({ error: 'Vacancy not found' });
        }

        // Analyze and update candidates missing ai_feedback_analysis.match_score.
        // One batch rank call replaces the old per-candidate inline scoring.
        const missing = candidates.filter(
            (c) => !c.ai_feedback_analysis || typeof c.ai_feedback_analysis.match_score !== 'number'
        );
        if (missing.length > 0) {
            try {
                const ranked = await rankViaService(vacancy, missing, req.headers['x-correlation-id']);
                const byId = new Map((ranked.results || []).map((r) => [String(r.candidate_id), r]));
                for (const candidate of missing) {
                    const r = byId.get(String(candidate.id ?? candidate._id));
                    if (!r || typeof r.score !== 'number') continue;
                    candidate.ai_feedback_analysis = {
                        match_score: r.score,
                        match_level: r.match_level || 'Low Match',
                        recommendation: r.explanation?.recommendation || '',
                        summary: r.explanation?.summary || '',
                        generated_at: new Date()
                    };
                    await Application.updateById(candidate.application_id, {
                        ai_feedback_analysis: candidate.ai_feedback_analysis
                    });
                }
            } catch (e) {
                // Best-effort enrichment — the list is still served without scores.
                logger.error('AI ranking unavailable for candidate list:', e);
            }
        }

        // No refetch needed — candidates are already updated in memory
        const candidatesWithFeedbackStatus = candidates.map((candidate) => ({
            ...candidate,
            needs_feedback: candidate.status === 'accepted' && !candidate.hiring_feedback
        }));

        res.json(candidatesWithFeedbackStatus);
    } catch (err) {
        logger.error('Error fetching candidates:', err);
        res.status(500).json({ error: 'Error fetching candidates' });
    }
});

// GET /api/vacancies/:id/applications — canonical applications list (HR only).
// Same data as /:id/candidates but with the application as the top-level
// resource and the candidate nested inside it.
router.get('/:id/applications', isHR, validate({ params: schemas.idParam }), async (req, res) => {
    try {
        const vacancy = await Vacancy.findById(req.params.id);
        if (!vacancy) {
            return res.status(404).json({ error: 'Vacancy not found' });
        }
        const applications = await Application.findDetailedByVacancy(req.params.id);
        res.json(applications);
    } catch (err) {
        logger.error('Error fetching applications:', err);
        res.status(500).json({ error: 'Error fetching applications' });
    }
});

// DELETE /api/vacancies/:id (HR only — soft-deletes the vacancy and its
// applications in one transaction; FKs are RESTRICT, nothing is removed)
router.delete('/:id', isHR, validate({ params: schemas.idParam }), async (req, res) => {
    try {
        const deletedVacancy = await Vacancy.softDeleteById(req.params.id, { closedBy: req.user.id });
        if (!deletedVacancy) {
            return res.status(404).json({ error: 'Vacancy not found' });
        }
        await audit.record({
            actorId: req.user.id,
            action: 'vacancy.delete',
            entity: 'vacancies',
            entityId: deletedVacancy.id,
            metadata: { title: deletedVacancy.title }
        });
        res.json({ message: 'Vacancy and associated applications deleted successfully' });
    } catch (error) {
        logger.error('Error deleting vacancy:', error);
        res.status(500).json({ error: 'Error deleting vacancy' });
    }
});

module.exports = router;
