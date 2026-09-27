const { z } = require('zod');
const { eventEnvelope } = require('./base');

// Events published by apps/recruitment-core once the vacancies/candidates/
// applications domain leaves the monolith (docs/extraction/recruitment-core.md).
//
// These mirror the legacy `strafor.vacancy.*` / `strafor.candidate.*` /
// `strafor.application.*` envelopes (see vacancy.js, candidate.js,
// application.js). During the transition BOTH families are published so
// consumers can migrate without a flag day; the legacy types are deprecated
// once the monolith stops owning the domain.

const candidateStatus = z.enum(['pending', 'interview', 'accepted', 'rejected']);

const RecruitmentVacancyPublished = eventEnvelope(
    'strafor.recruitment.vacancy_published',
    1,
    z
        .object({
            vacancyId: z.number().int().positive(),
            title: z.string().min(1),
            department: z.string().min(1),
            location: z.string().min(1),
            type: z.string().min(1),
            experienceLevel: z.string().optional(),
            skillsRequired: z.array(z.string()).default([]),
            publishedBy: z.number().int().positive().optional()
        })
        .strict()
);

const RecruitmentVacancyUpdated = eventEnvelope(
    'strafor.recruitment.vacancy_updated',
    1,
    z
        .object({
            vacancyId: z.number().int().positive(),
            // Only changed fields are included — consumers merge into their projection.
            changedFields: z.array(z.string()).default([]),
            vacancy: z.record(z.string(), z.unknown()).default({})
        })
        .strict()
);

const RecruitmentVacancyClosed = eventEnvelope(
    'strafor.recruitment.vacancy_closed',
    1,
    z
        .object({
            vacancyId: z.number().int().positive(),
            reason: z.enum(['filled', 'cancelled', 'deleted']).default('deleted'),
            closedBy: z.number().int().positive().optional()
        })
        .strict()
);

const RecruitmentApplicationSubmitted = eventEnvelope(
    'strafor.recruitment.application_submitted',
    1,
    z
        .object({
            applicationId: z.number().int().positive(),
            candidateId: z.number().int().positive(),
            vacancyId: z.number().int().positive(),
            email: z.string().email(),
            resumeDocumentId: z.string().uuid().optional(),
            appliedAt: z.string().datetime({ offset: true })
        })
        .strict()
);

const RecruitmentCandidateStatusChanged = eventEnvelope(
    'strafor.recruitment.candidate_status_changed',
    1,
    z
        .object({
            candidateId: z.number().int().positive(),
            applicationId: z.number().int().positive().optional(),
            vacancyId: z.number().int().positive().optional(),
            previousStatus: candidateStatus.optional(),
            newStatus: candidateStatus,
            changedBy: z.number().int().positive().optional()
        })
        .strict()
);

const RecruitmentHiringDecisionRecorded = eventEnvelope(
    'strafor.recruitment.hiring_decision_recorded',
    1,
    z
        .object({
            candidateId: z.number().int().positive(),
            applicationId: z.number().int().positive().optional(),
            vacancyId: z.number().int().positive().optional(),
            decision: z.enum(['hired', 'rejected', 'offer_extended']),
            feedback: z.string().min(1),
            recordedBy: z.number().int().positive().optional()
        })
        .strict()
);

// Offer lifecycle — ids + decision only, no compensation data on the bus.
const RecruitmentOfferDecided = eventEnvelope(
    'strafor.recruitment.offer_decided',
    1,
    z
        .object({
            offerId: z.number().int().positive(),
            applicationId: z.number().int().positive(),
            candidateId: z.number().int().positive().optional(),
            vacancyId: z.number().int().positive().optional(),
            decision: z.enum(['accepted', 'declined']),
            reason: z.string().optional(),
            decidedBy: z.number().int().positive().optional(),
            decidedAt: z.string().datetime({ offset: true })
        })
        .strict()
);

module.exports = {
    RecruitmentVacancyPublished,
    RecruitmentVacancyUpdated,
    RecruitmentVacancyClosed,
    RecruitmentApplicationSubmitted,
    RecruitmentCandidateStatusChanged,
    RecruitmentHiringDecisionRecorded,
    RecruitmentOfferDecided
};
