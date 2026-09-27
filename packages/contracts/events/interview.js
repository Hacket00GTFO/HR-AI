const { z } = require('zod');
const { eventEnvelope } = require('./base');

// Interview events published by apps/recruitment-core.
//
// `strafor.interview.scheduled` is the type the notifications consumer already
// routes on (apps/notifications/src/consumer.ts): it reads payload.email
// (invite recipient), payload.name, payload.vacancyTitle and
// payload.scheduledAt — keep those keys stable. ids + display refs only;
// no PII beyond the email needed to deliver the invite.
const InterviewScheduled = eventEnvelope(
    'strafor.interview.scheduled',
    1,
    z
        .object({
            interviewId: z.number().int().positive(),
            applicationId: z.number().int().positive(),
            candidateId: z.number().int().positive(),
            vacancyId: z.number().int().positive(),
            scheduledAt: z.string().datetime({ offset: true }),
            durationMinutes: z.number().int().positive().optional(),
            interviewerUserId: z.number().int().positive().optional(),
            interviewerName: z.string().optional(),
            locationOrLink: z.string().optional(),
            // Candidate invite recipient (the only PII in this event).
            email: z.string().email(),
            name: z.string().optional(),
            vacancyTitle: z.string().optional(),
            idempotencyKey: z.string().optional()
        })
        .strict()
);

module.exports = { InterviewScheduled };
