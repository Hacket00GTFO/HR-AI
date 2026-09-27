const { z } = require('zod');
const { eventEnvelope } = require('./base');

// Document-domain events emitted by the documents-resumes service.
//
// These intentionally use `strafor.document.*` type strings (not
// `strafor.resume.*`): resume.js already defines resume events for the
// legacy monolith upload flow with a different payload shape (storageKey,
// required candidateId, skills). Document events are keyed by documentId
// and tolerate a null candidate link while the candidates service resolves
// ownership asynchronously.

const documentBase = {
    documentId: z.string().uuid(),
    // Plain FK-free reference — no cross-service FK per service-DB contract.
    candidateId: z.number().int().positive().optional(),
    kind: z.string().min(1).default('resume')
};

// POST /v1/documents accepted an upload (or matched a sha256 dedupe).
const ResumeUploaded = eventEnvelope(
    'strafor.document.uploaded',
    1,
    z
        .object({
            ...documentBase,
            s3Key: z.string().min(1),
            mime: z.enum([
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            ]),
            sizeBytes: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            deduplicated: z.boolean().default(false)
        })
        .strict()
);

// Extraction worker finished — text is available at GET /v1/documents/:id/text.
const ResumeParsed = eventEnvelope(
    'strafor.document.parsed',
    1,
    z
        .object({
            ...documentBase,
            chars: z.number().int().nonnegative(),
            pageCount: z.number().int().nonnegative().optional(),
            parseVersion: z.string().min(1)
        })
        .strict()
);

module.exports = { ResumeUploaded, ResumeParsed };
