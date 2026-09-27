const { z } = require('zod');
const { eventEnvelope } = require('./base');

// Emitted when a candidate application is created (POST /api/candidates,
// POST /api/public/apply in the monolith; POST /v1/candidates,
// POST /v1/public/apply in recruitment-core).
// The optional name/vacancyTitle keys are what the notifications consumer
// (apps/notifications/src/consumer.ts) reads for the "application received"
// email — they were always part of the de-facto payload, now contract-fixed.
const ApplicationSubmitted = eventEnvelope(
    'strafor.application.submitted',
    1,
    z
        .object({
            candidateId: z.number().int().positive(),
            vacancyId: z.number().int().positive(),
            email: z.string().email(),
            appliedAt: z.string().datetime({ offset: true }),
            hasResume: z.boolean().default(false),
            // additive keys consumed by notifications / analytics (optional so
            // legacy monolith publishers stay contract-valid)
            applicationId: z.number().int().positive().optional(),
            name: z.string().optional(),
            vacancyTitle: z.string().optional(),
            resumeDocumentId: z.string().uuid().optional(),
            source: z.string().optional(),
            idempotencyKey: z.string().optional()
        })
        .strict()
);

module.exports = { ApplicationSubmitted };
