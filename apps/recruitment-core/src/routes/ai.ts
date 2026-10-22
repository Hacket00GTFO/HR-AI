import { Router } from 'express';
import * as Candidate from '../models/candidate.js';
import * as Application from '../models/application.js';
import * as Vacancy from '../models/vacancy.js';
import { callService } from '../serviceClient.js';
import { serviceOrHrAuth } from '../auth.js';
import { validate } from '../validate.js';
import * as schemas from '../schemas.js';
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

export function aiRouter(deps: ServiceDeps): Router {
    const { pool, config, log } = deps;
    const hr = serviceOrHrAuth(config.SERVICE_AUTH_TOKEN);
    const router = Router();

    // POST /v1/ai/process-feedback (HR only)
    router.post('/process-feedback', hr, validate({ body: schemas.processFeedbackBody }), async (req, res) => {
        try {
            const { candidateId, feedback, vacancyId } = req.body;

            const candidate = await Candidate.findById(pool, candidateId);
            if (!candidate) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            // Status lives on the application — resolve the (candidate, vacancy) one.
            const application = await Application.resolveForCandidate(pool, candidateId, vacancyId);
            if (!application) {
                return res.status(404).json({ error: 'Application not found' });
            }

            if (application.status !== 'accepted') {
                return res.status(400).json({ error: 'Feedback can only be processed for accepted candidates' });
            }

            const vacancy = await Vacancy.findById(pool, vacancyId);
            if (!vacancy) {
                return res.status(404).json({ error: 'Vacancy not found' });
            }

            // Score the REAL candidate against the REAL vacancy via the
            // ai-matching service. The hiring feedback itself is stored
            // verbatim — it is not fed into the scorer as a fake description.
            let scoreResult: Row;
            try {
                scoreResult = (await callService(config.AI_SERVICE_URL, '/v1/score', {
                    method: 'POST',
                    timeout: 10000,
                    correlationId: req.correlationId,
                    serviceToken: config.SERVICE_AUTH_TOKEN,
                    body: {
                        candidate: candidatePayload(candidate),
                        vacancy: vacancyPayload(vacancy)
                    }
                })) as Row;
            } catch (aiError) {
                log.error({ err: aiError instanceof Error ? aiError.message : aiError }, 'AI service call failed');
                return res.status(503).json({ error: 'AI service unavailable' });
            }

            const score = scoreResult.score;
            const explanation = scoreResult.explanation || {};
            const matchLevel = explanation.match_level || 'Low Match';
            const recommendation = explanation.recommendation || 'May not be the best fit for this position';

            const insights = {
                match_score: score,
                match_level: matchLevel,
                recommendation,
                summary:
                    explanation.summary ||
                    `The candidate shows a ${matchLevel.toLowerCase()} (${Math.round(score * 100)}%) alignment with the position requirements. ${recommendation}.`,
                score_breakdown: scoreResult.subscores || {},
                source: scoreResult.source,
                timestamp: new Date(),
                feedback: feedback
            };

            const updatedCandidate = await Application.updateById(pool, application.id, {
                hiring_feedback: feedback,
                ai_feedback_analysis: insights,
                feedback_timestamp: new Date()
            }).then(() => Application.legacyRow(pool, application.id));

            if (!updatedCandidate) {
                throw new Error('Failed to update candidate with feedback analysis');
            }

            res.json({
                success: true,
                insights,
                candidate: updatedCandidate
            });
        } catch (error) {
            log.error({ err: error instanceof Error ? error.message : error }, 'Error processing AI feedback');
            res.status(500).json({ error: 'Error processing feedback' });
        }
    });

    return router;
}
