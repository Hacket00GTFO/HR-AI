const express = require('express');
const router = express.Router();
const Candidate = require('../models/Candidate');
const Application = require('../models/Application');
const Vacancy = require('../models/Vacancy');
const { callService } = require('../utils/serviceClient');
const logger = require('../utils/logger');
const { isHR } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || null;

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

// POST /api/ai/process-feedback (HR only)
router.post('/process-feedback', isHR, validate({ body: schemas.processFeedbackBody }), async (req, res) => {
    try {
        const { candidateId, feedback, vacancyId } = req.body;

        const candidate = await Candidate.findById(candidateId);
        if (!candidate) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        // Status lives on the application — resolve the (candidate, vacancy) one.
        const application = await Application.resolveForCandidate(candidateId, vacancyId);
        if (!application) {
            return res.status(404).json({ error: 'Application not found' });
        }

        if (application.status !== 'accepted') {
            return res.status(400).json({ error: 'Feedback can only be processed for accepted candidates' });
        }

        const vacancy = await Vacancy.findById(vacancyId);
        if (!vacancy) {
            return res.status(404).json({ error: 'Vacancy not found' });
        }

        // Score the REAL candidate against the REAL vacancy via the
        // ai-matching service. The hiring feedback itself is stored verbatim —
        // it is not fed into the scorer as a fake "description".
        let scoreResult;
        try {
            scoreResult = await callService(AI_SERVICE_URL, '/v1/score', {
                method: 'POST',
                timeout: 10000,
                correlationId: req.headers['x-correlation-id'],
                body: {
                    candidate: candidatePayload(candidate),
                    vacancy: vacancyPayload(vacancy)
                }
            });
        } catch (aiError) {
            logger.error('AI service call failed:', aiError);
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

        const updatedCandidate = await Application.updateById(application.id, {
            hiring_feedback: feedback,
            ai_feedback_analysis: insights,
            feedback_timestamp: new Date()
        }).then(() => Application.legacyRow(application.id));

        if (!updatedCandidate) {
            throw new Error('Failed to update candidate with feedback analysis');
        }

        res.json({
            success: true,
            insights,
            candidate: updatedCandidate
        });
    } catch (error) {
        logger.error('Error processing AI feedback:', error);
        res.status(500).json({ error: 'Error processing feedback' });
    }
});

module.exports = router;
