import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { httpError } from '@strafor/node-common';
import { withTransaction } from '../db.js';
import * as Candidate from '../models/candidate.js';
import * as Application from '../models/application.js';
import { enqueueEvent, flushOutbox } from '../events.js';
import { fetchDocumentDownload, ServiceError, uploadDocument } from '../serviceClient.js';
import { serviceOrHrAuth, type GatewayUser } from '../auth.js';
import { validate } from '../validate.js';
import * as schemas from '../schemas.js';
import { validateUploadBuffer } from '../fileValidation.js';
import { applicationSubmittedPayloads } from '../payloads.js';
import type { ServiceDeps } from '../deps.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function candidatesRouter(deps: ServiceDeps): Router {
    const { pool, config, publisher, log } = deps;
    const hr = serviceOrHrAuth(config.SERVICE_AUTH_TOKEN);
    const router = Router();

    // Resumes are stored in documents-resumes now; RESUMES_DIR remains ONLY as
    // a fallback for rows that still carry the legacy `resume` filename
    // (pre-extraction local storage).
    const RESUMES_DIR = config.RESUMES_DIR;

    // In-memory upload — the buffer is re-validated (magic bytes) then
    // forwarded to documents-resumes. Nothing touches local disk.
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

    // Forward a validated upload to documents-resumes; returns the document id.
    // `user` is the gateway caller when present; the synthetic service caller
    // identity is used for anonymous flows (public apply).
    async function storeResume(file: Express.Multer.File, user: GatewayUser | null, correlationId?: string) {
        const { mime } = validateUploadBuffer(file.buffer, file.originalname);
        const doc = await uploadDocument(
            config.DOCUMENTS_URL,
            { buffer: file.buffer, originalname: file.originalname, mime },
            {
                kind: 'resume',
                correlationId,
                serviceToken: config.SERVICE_AUTH_TOKEN,
                user: user ?? { userId: config.SERVICE_CALLER_USER_ID, role: 'hr' }
            }
        );
        return doc.id;
    }

    // POST /v1/candidates/upload — resume upload (HR only). Returns the
    // documents-resumes document id under both the legacy `path` key and the
    // explicit `document_id`.
    router.post('/upload', hr, uploadResume, async (req, res, next) => {
        try {
            if (!req.file) {
                throw httpError(400, 'No file uploaded');
            }
            const documentId = await storeResume(req.file, req.user ?? null, req.correlationId);
            res.json({
                path: documentId,
                document_id: documentId,
                message: 'Resume uploaded successfully'
            });
        } catch (error) {
            if (error instanceof ServiceError) {
                return next(httpError(503, 'Documents service unavailable'));
            }
            next(error);
        }
    });

    // GET /v1/candidates — one row per application, vacancy title populated
    // (HR only). Filters: ?status= & vacancy_id=/applied_for= map onto
    // Application filters; ?q= is a case-insensitive substring match across
    // name, email and skills; ?orderBy= / ?limit= are whitelisted inside the
    // model (never interpolated).
    router.get('/', hr, validate({ query: schemas.candidateListQuery }), async (req, res, next) => {
        try {
            const { status, vacancy_id, applied_for, q, orderBy, limit } = req.query as Row;

            const candidates = await Application.findWithVacancyTitle(
                pool,
                { status, vacancy_id: vacancy_id ?? applied_for },
                { orderBy }
            );

            // `q` runs in memory — the HR data set is bounded and the model
            // owns the SQL. Same fields the legacy UI searched (name + skills)
            // plus email.
            const needle = q ? String(q).toLowerCase() : null;
            const matched = needle
                ? candidates.filter((c) =>
                      `${c.first_name ?? ''} ${c.last_name ?? ''} ${c.email ?? ''} ${c.skills ?? ''}`
                          .toLowerCase()
                          .includes(needle)
                  )
                : candidates;

            const capped = limit ? matched.slice(0, limit) : matched;

            const formattedCandidates = capped.map((candidate) => ({
                ...candidate,
                applied_at: candidate.applied_at
                    ? new Date(candidate.applied_at).toISOString()
                    : new Date().toISOString()
            }));

            res.json(formattedCandidates);
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/candidates/:id/resume — authenticated resume download (HR only).
    // Primary path: resume_document_id → documents-resumes presigned URL →
    // 302 redirect. Legacy fallback: `resume` filename under RESUMES_DIR
    // (path-traversal safe: basename only, must resolve inside the dir).
    router.get('/:id/resume', hr, validate({ params: schemas.idParam }), async (req, res, next) => {
        try {
            const candidate = await Candidate.findById(pool, req.params.id);
            if (!candidate) {
                throw httpError(404, 'Resume not found');
            }

            if (candidate.resume_document_id) {
                if (!config.DOCUMENTS_URL) {
                    throw httpError(503, 'Documents service unavailable');
                }
                try {
                    const download = await fetchDocumentDownload(config.DOCUMENTS_URL, candidate.resume_document_id, {
                        correlationId: req.correlationId,
                        serviceToken: config.SERVICE_AUTH_TOKEN,
                        user: req.user ?? null
                    });
                    return res.redirect(302, download.url);
                } catch (err) {
                    if (err instanceof ServiceError && err.status === 404) {
                        throw httpError(404, 'Resume not found');
                    }
                    if (err instanceof ServiceError) {
                        throw httpError(503, 'Documents service unavailable');
                    }
                    throw err;
                }
            }

            if (!candidate.resume || !RESUMES_DIR) {
                throw httpError(404, 'Resume not found');
            }

            const safeName = path.basename(candidate.resume);
            const resolvedDir = path.resolve(RESUMES_DIR);
            const filePath = path.resolve(resolvedDir, safeName);
            if (!filePath.startsWith(resolvedDir + path.sep)) {
                throw httpError(400, 'Invalid resume path');
            }

            res.sendFile(filePath, (err) => {
                if (err && !res.headersSent) {
                    res.status(404).json({ error: 'Resume not found' });
                }
            });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/candidates/:id/history — status timeline for the candidate's
    // application (HR only). History is per-application: ?vacancy_id= (or the
    // legacy applied_for) picks which one when the candidate applied to more
    // than one vacancy; defaults to the most recent application.
    router.get(
        '/:id/history',
        hr,
        validate({ params: schemas.idParam, query: schemas.candidateHistoryQuery }),
        async (req, res, next) => {
            try {
                const vacancyId = (req.query as Row).vacancy_id ?? (req.query as Row).applied_for;
                const application = await Application.resolveForCandidate(pool, req.params.id, vacancyId);
                if (!application) {
                    throw httpError(404, 'Candidate or application not found');
                }
                const history = await Application.history(pool, application.id);
                res.json(history);
            } catch (err) {
                next(err);
            }
        }
    );

    // POST /v1/candidates — create candidate (with optional resume file) (HR only)
    router.post('/', hr, uploadResume, validate({ body: schemas.candidateCreateBody }), async (req, res, next) => {
        try {
            // Two resume paths (extraction spec §8): (b) multipart file on
            // this request → validated + forwarded to documents-resumes; or
            // (a) a pre-uploaded resume_document_id the client obtained from
            // POST /v1/documents itself.
            let resumeDocumentId: string | null = req.body.resume_document_id ?? null;
            if (req.file) {
                resumeDocumentId = await storeResume(req.file, req.user ?? null, req.correlationId);
            }

            const candidateData: Candidate.CandidateCreateData = {
                ...req.body,
                applied_at: req.body.applied_at ? new Date(req.body.applied_at) : new Date(),
                resume_document_id: resumeDocumentId
            };

            // Single tx: candidate (upsert on unique email) + application +
            // initial status-history row + skills links + outbox events.
            const response = await withTransaction(pool, async (client) => {
                const created = await Candidate.createWithVacancy(client, candidateData, {
                    createdBy: req.user?.userId ?? null
                });
                const { recruitment, legacy } = applicationSubmittedPayloads(
                    created,
                    { id: created.application_id, vacancy_id: req.body.applied_for, applied_at: created.applied_at },
                    created.applied_for?.title ?? null,
                    'hr'
                );
                await enqueueEvent(client, 'strafor.recruitment.application_submitted', recruitment, req.correlationId);
                await enqueueEvent(client, 'strafor.application.submitted', legacy, req.correlationId);
                return created;
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            res.status(201).json(response);
        } catch (err) {
            if (err instanceof ServiceError) {
                return next(httpError(503, 'Documents service unavailable'));
            }
            next(err);
        }
    });

    // PUT /v1/candidates/:id/status (HR only)
    // Status lives on the application now: body may carry vacancy_id (or the
    // legacy applied_for) to pick which application; defaults to the latest one.
    router.put(
        '/:id/status',
        hr,
        validate({ params: schemas.idParam, body: schemas.candidateStatusBody }),
        async (req, res, next) => {
            try {
                const { id } = req.params;
                const { status } = req.body;
                const vacancyId = req.body.vacancy_id ?? req.body.applied_for;
                const changedBy = req.user?.userId ?? null;

                const result = await withTransaction(pool, async (client) => {
                    const application = await Application.resolveForCandidate(client, id, vacancyId);
                    if (!application) return null;
                    const previousStatus = application.status;
                    const vacancyTitle =
                        application.vacancy_id != null
                            ? ((
                                  await client.query('SELECT title FROM vacancies WHERE id = $1', [
                                      application.vacancy_id
                                  ])
                              ).rows[0]?.title ?? null)
                            : null;
                    const updated = await Application.updateStatus(pool, application.id, status, {
                        changedBy,
                        client
                    });
                    if (updated) {
                        const payload: Row = {
                            candidateId: Number(id),
                            applicationId: application.id,
                            ...(application.vacancy_id != null ? { vacancyId: application.vacancy_id } : {}),
                            ...(previousStatus ? { previousStatus } : {}),
                            newStatus: String(status).toLowerCase(),
                            ...(changedBy ? { changedBy } : {})
                        };
                        await enqueueEvent(
                            client,
                            'strafor.recruitment.candidate_status_changed',
                            payload,
                            req.correlationId
                        );
                        await enqueueEvent(
                            client,
                            'strafor.candidate.status_changed',
                            {
                                ...payload,
                                email: updated.email,
                                name: `${updated.first_name ?? ''} ${updated.last_name ?? ''}`.trim() || undefined,
                                vacancyTitle: vacancyTitle ?? undefined,
                                idempotencyKey: `status:${application.id}:${payload.newStatus}:${Date.now()}`
                            },
                            req.correlationId
                        );
                    }
                    return updated;
                });

                if (!result) {
                    throw httpError(404, 'Candidate or application not found');
                }
                await flushOutbox(pool, publisher, log).catch(() => 0);

                res.json(result);
            } catch (err) {
                next(err);
            }
        }
    );

    // PUT /v1/candidates/:id/feedback (HR only)
    router.put(
        '/:id/feedback',
        hr,
        validate({ params: schemas.idParam, body: schemas.candidateFeedbackBody }),
        async (req, res, next) => {
            try {
                const { id } = req.params;
                const { hiring_feedback, ai_insights } = req.body;
                const vacancyId = req.body.vacancy_id ?? req.body.applied_for;
                const recordedBy = req.user?.userId ?? null;

                const application = await Application.resolveForCandidate(pool, id, vacancyId);
                if (!application) {
                    throw httpError(404, 'Candidate or application not found');
                }

                if (application.status !== 'accepted') {
                    throw httpError(400, 'Feedback can only be provided for accepted candidates');
                }

                const updatedCandidate = await withTransaction(pool, async (client) => {
                    await Application.updateById(
                        pool,
                        application.id,
                        {
                            hiring_feedback,
                            ai_insights,
                            feedback_timestamp: new Date()
                        },
                        { client }
                    );
                    // The endpoint only accepts feedback on already-accepted
                    // candidates → the hiring decision is 'hired'.
                    const payload: Row = {
                        candidateId: Number(id),
                        applicationId: application.id,
                        ...(application.vacancy_id != null ? { vacancyId: application.vacancy_id } : {}),
                        decision: 'hired',
                        feedback: hiring_feedback,
                        ...(recordedBy ? { recordedBy } : {})
                    };
                    await enqueueEvent(
                        client,
                        'strafor.recruitment.hiring_decision_recorded',
                        payload,
                        req.correlationId
                    );
                    await enqueueEvent(
                        client,
                        'strafor.candidate.hiring_decision_recorded',
                        { ...payload, idempotencyKey: `feedback:${application.id}:${Date.now()}` },
                        req.correlationId
                    );
                    return Application.legacyRow(client, application.id);
                });
                await flushOutbox(pool, publisher, log).catch(() => 0);

                res.json(updatedCandidate);
            } catch (err) {
                next(err);
            }
        }
    );

    return router;
}
