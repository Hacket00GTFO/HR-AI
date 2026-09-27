const { z } = require('zod');
const { eventEnvelope } = require('./base');

// POST /api/candidates/upload — a CV file landed in secure storage.
const ResumeUploaded = eventEnvelope('strafor.resume.uploaded', 1, z.object({
    candidateId: z.number().int().positive().optional(),
    storageKey: z.string().min(1),
    contentType: z.enum(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
    sizeBytes: z.number().int().positive(),
    uploadedBy: z.number().int().positive().optional()
}).strict());

// Emitted by the (future) resume-parsing service once text extraction completes.
const ResumeParsed = eventEnvelope('strafor.resume.parsed', 1, z.object({
    candidateId: z.number().int().positive(),
    storageKey: z.string().min(1),
    skills: z.array(z.string()).default([]),
    experienceYears: z.number().nonnegative().optional(),
    education: z.string().optional(),
    parseConfidence: z.number().min(0).max(1).optional()
}).strict());

module.exports = { ResumeUploaded, ResumeParsed };
