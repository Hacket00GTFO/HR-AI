const { z } = require('zod');
const { eventEnvelope } = require('./base');

// Emitted when a vacancy is created/published in apps/api (routes/vacancies.js)
// or recruitment-core (POST /v1/vacancies).
const VacancyPublished = eventEnvelope(
    'strafor.vacancy.published',
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

// Emitted on PUT /v1/vacancies/:id. ai-matching already consumes this type
// (apps/ai-matching/app/events.py CONSUMED_KEYS); the schema mirrors
// strafor.recruitment.vacancy_updated.
const VacancyUpdated = eventEnvelope(
    'strafor.vacancy.updated',
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

module.exports = { VacancyPublished, VacancyUpdated };
