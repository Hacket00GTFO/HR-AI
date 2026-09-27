const { z } = require('zod');
const { eventEnvelope } = require('./base');

const candidateStatus = z.enum(['pending', 'interview', 'accepted', 'rejected']);

// PUT /api/candidates/:id.status (monolith) / PUT /v1/candidates/:id/status
// (recruitment-core). The optional email/name/vacancyTitle keys are what the
// notifications consumer reads for the status-changed email.
const CandidateStatusChanged = eventEnvelope(
    'strafor.candidate.status_changed',
    1,
    z
        .object({
            candidateId: z.number().int().positive(),
            vacancyId: z.number().int().positive().optional(),
            previousStatus: candidateStatus.optional(),
            newStatus: candidateStatus,
            changedBy: z.number().int().positive().optional(),
            // additive keys consumed by notifications / analytics
            applicationId: z.number().int().positive().optional(),
            email: z.string().email().optional(),
            name: z.string().optional(),
            vacancyTitle: z.string().optional(),
            idempotencyKey: z.string().optional()
        })
        .strict()
);

// PUT /api/candidates/:id/feedback — hiring decision captured on accepted candidates.
const HiringDecisionRecorded = eventEnvelope(
    'strafor.candidate.hiring_decision_recorded',
    1,
    z
        .object({
            candidateId: z.number().int().positive(),
            vacancyId: z.number().int().positive().optional(),
            decision: z.enum(['hired', 'rejected', 'offer_extended']),
            feedback: z.string().min(1),
            recordedBy: z.number().int().positive().optional(),
            applicationId: z.number().int().positive().optional(),
            idempotencyKey: z.string().optional()
        })
        .strict()
);

module.exports = { CandidateStatusChanged, HiringDecisionRecorded };
