import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { withTransaction } from '../db.js';
import * as Candidate from '../models/candidate.js';
import * as Vacancy from '../models/vacancy.js';
import { enqueueEvent, flushOutbox } from '../events.js';
import { ServiceError, uploadDocument } from '../serviceClient.js';
import * as schemas from '../schemas.js';
import { validateUploadBuffer } from '../fileValidation.js';
import { applicationSubmittedPayloads } from '../payloads.js';
import type { ServiceDeps } from '../deps.js';

// Public, unauthenticated endpoints — currently only the careers "apply" flow
// (POST /v1/public/apply). Everything here must stay PII-minimal and is
// rate-limited harder than the global API limiter.

export function publicRouter(deps: ServiceDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();

    // Resumes live in documents-resumes now — the upload is received in
    // memory, re-validated (extension + magic bytes + size), then forwarded
    // over the service-to-service channel. Nothing lands on local disk.
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 }
    });

    // Wrap multer so upload errors map to clean HTTP statuses instead of 500s.
    function uploadResume(req: Request, res: Response, next: NextFunction) {
        upload.single('resume')(req, res, (err: unknown) => {
            if (!err) return next();
            if (err instanceof multer.MulterError) {
                const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                return res.status(status).json({ error: `Upload rejected: ${err.message}` });
            }
            const e = err as Error & { status?: number };
            return res.status(e.status || 400).json({ error: e.message });
        });
    }

    // Same error shape as validate.js, inlined because the upload buffer must
    // be discarded anyway on failure (nothing to clean on disk with memory
    // storage — kept for parity with the monolith's flow).
    function validateApplyBody(req: Request, res: Response): boolean {
        const result = schemas.publicApplyBody.safeParse(req.body);
        if (result.success) {
            req.body = result.data;
            return true;
        }
        res.status(400).json({
            error: 'Validation failed',
            details: result.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message
            }))
        });
        return false;
    }

    // GET /v1/public/jobs — anonymous careers listing. Returns open
    // ('Active') vacancies in a reduced public-safe shape: id, title,
    // company, department, location, employment_type, description,
    // requirements, responsibilities, skills_required, experience_level,
    // benefits, remote_option, application_deadline, published_at.
    // Salary columns, external_postings and internal refs stay server-side.
    router.get('/jobs', async (_req, res, next) => {
        try {
            const jobs = await Vacancy.findOpen(pool);
            res.json(jobs);
        } catch (err) {
            next(err);
        }
    });

    // Dedicated limiter for the anonymous apply endpoint — much stricter than
    // the global API limiter (20 submissions/hour/IP vs 600/15min globally).
    const applyLimiter = rateLimit({
        windowMs: config.PUBLIC_APPLY_RATE_WINDOW_MS,
        limit: config.PUBLIC_APPLY_RATE_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many applications submitted, please try again later.' }
    });

    // POST /v1/public/apply — anonymous job application.
    // multipart/form-data: candidate fields + optional `resume` (pdf/docx,
    // <=5MB). 201 { application_id, message } on success; 200 { message } when
    // the candidate already applied to this vacancy (partial unique index on
    // applications(candidate_id, vacancy_id) WHERE deleted_at IS NULL).
    router.post('/apply', applyLimiter, uploadResume, async (req, res) => {
        try {
            if (!validateApplyBody(req, res)) return;

            // Friendly 404 instead of a raw FK violation for dead vacancy ids.
            const vacancy = await Vacancy.findById(pool, req.body.applied_for);
            if (!vacancy) {
                return res.status(404).json({ error: 'Vacancy not found' });
            }

            let resumeDocumentId: string | null = null;
            if (req.file) {
                // Magic bytes must match the claimed type — a spoofed
                // extension is rejected with 415.
                const { mime } = validateUploadBuffer(req.file.buffer, req.file.originalname);
                const doc = await uploadDocument(
                    config.DOCUMENTS_URL,
                    { buffer: req.file.buffer, originalname: req.file.originalname, mime },
                    {
                        kind: 'resume',
                        correlationId: req.correlationId,
                        serviceToken: config.SERVICE_AUTH_TOKEN,
                        // Anonymous flow — documents-resumes gets the synthetic
                        // service-caller identity (config.ServiceCallerUserID).
                        user: { userId: config.SERVICE_CALLER_USER_ID, role: 'hr' }
                    }
                );
                resumeDocumentId = doc.id;
            }

            const candidateData: Candidate.CandidateCreateData = {
                ...req.body,
                applied_at: new Date(),
                resume_document_id: resumeDocumentId
            };

            // Single tx: candidate (upsert on unique email) + application +
            // initial status-history row + skills links + outbox events.
            // No actor — public flow.
            const response = await withTransaction(pool, async (client) => {
                const created = await Candidate.createWithVacancy(client, candidateData, { createdBy: null });
                const { recruitment, legacy } = applicationSubmittedPayloads(
                    created,
                    { id: created.application_id, vacancy_id: req.body.applied_for, applied_at: created.applied_at },
                    vacancy.title ?? null,
                    'public'
                );
                await enqueueEvent(client, 'strafor.recruitment.application_submitted', recruitment, req.correlationId);
                await enqueueEvent(client, 'strafor.application.submitted', legacy, req.correlationId);
                return created;
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            log.debug(
                `Public application received: application ${response.application_id} for vacancy ${req.body.applied_for}`
            );
            res.status(201).json({
                application_id: response.application_id,
                message: 'Application received'
            });
        } catch (err) {
            const e = err as Error & { code?: string; status?: number };
            // One live application per (candidate, vacancy) — the partial
            // unique index fires on re-application; answer idempotently.
            if (e && e.code === '23505') {
                return res.status(200).json({ message: 'Application already received' });
            }
            if (e && e.code === '23503') {
                return res.status(404).json({ error: 'Vacancy not found' });
            }
            if (err instanceof ServiceError) {
                return res.status(503).json({ error: 'Error submitting application' });
            }
            if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 415) {
                // Extension vs magic-byte messages are distinct upstream.
                return res.status(415).json({ error: e.message });
            }
            log.error({ err: e.message }, 'Error processing public application');
            res.status(e.status || 500).json({ error: 'Error submitting application' });
        }
    });

    return router;
}
