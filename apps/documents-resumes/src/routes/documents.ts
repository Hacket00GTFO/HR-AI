import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import type { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ResumeUploaded } from '@strafor/contracts/events/document.js';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import { canAccessDocument, denyAdminContent, requireAuth, type Caller } from '../auth.js';
import { sanitizeFilename, sha256Hex, validateUploadBuffer } from '../fileValidation.js';
import { deleteObject, presignGetUrl, putObject } from '../s3.js';
import type { EventPublisher } from '../events.js';

export interface DocumentsDeps {
    pool: Pool;
    s3: S3Client;
    bucket: string;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const uploadMetaSchema = z.object({
    candidateId: z.coerce.number().int().positive().optional(),
    kind: z.string().min(1).max(40).default('resume')
});

function rowToDocument(row: Record<string, unknown>) {
    return {
        id: row.id,
        candidateId: row.owner_candidate_id ?? null,
        kind: row.kind,
        originalName: row.original_name,
        mime: row.mime,
        sizeBytes: Number(row.size_bytes),
        sha256: row.sha256,
        s3Key: row.s3_key,
        status: row.status,
        parseVersion: row.parse_version ?? null,
        error: row.error ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

async function enqueue(pool: Pool, type: string, payload: Record<string, unknown>): Promise<void> {
    await pool.query(`INSERT INTO jobs (type, payload) VALUES ($1, $2)`, [type, JSON.stringify(payload)]);
}

async function loadDocument(pool: Pool, id: string) {
    const { rows } = await pool.query(`SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows[0] ?? null;
}

function authorize(doc: { owner_candidate_id: number | null }, caller: Caller) {
    if (!canAccessDocument(caller, doc.owner_candidate_id)) {
        throw httpError(403, 'Forbidden');
    }
}

export function documentsRouter(deps: DocumentsDeps): Router {
    const { pool, s3, bucket, config, publisher, log } = deps;
    const router = Router();

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 }
    });

    const uploadSingle = (req: Request, res: Response, next: NextFunction) => {
        upload.single('file')(req, res, (err: unknown) => {
            if (!err) return next();
            if (err instanceof multer.MulterError) {
                const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                return res.status(status).json({ error: `Upload rejected: ${err.message}` });
            }
            next(err);
        });
    };

    // Every /v1/documents route requires auth (service token or gateway user
    // headers); asserted admin identities are denied before any handler —
    // platform admins must never touch business content (audit C1).
    const auth = requireAuth(config.SERVICE_AUTH_TOKEN);
    router.use(auth, denyAdminContent);

    // POST /v1/documents — multipart upload, sha256 dedupe, enqueue parse.
    router.post('/', uploadSingle, async (req, res, next) => {
        try {
            if (!req.file) throw httpError(400, 'No file uploaded — expected multipart field "file"');
            const meta = uploadMetaSchema.safeParse(req.body);
            if (!meta.success) {
                throw httpError(400, 'Invalid upload metadata', meta.error.issues);
            }

            const { ext, mime } = validateUploadBuffer(req.file.buffer, req.file.originalname);
            const safeName = sanitizeFilename(req.file.originalname, ext);
            const sha256 = sha256Hex(req.file.buffer);

            // Ownership claims (audit H1): a candidateId may only come from a
            // trusted service caller (X-Service-Token — the gateway asserting a
            // verified candidate identity, or internal services like
            // recruitment-core) or from verified hr staff. A plain user-auth
            // request cannot prove candidate identity, so a body candidateId
            // there is rejected rather than silently trusted.
            const caller = req.caller as Caller;
            const assertedCandidateId = caller.kind === 'service' ? (caller.user?.candidateId ?? null) : null;
            let candidateId = assertedCandidateId;
            if (meta.data.candidateId !== undefined) {
                if (caller.kind === 'service' || req.user?.role === 'hr') {
                    candidateId = meta.data.candidateId;
                } else {
                    throw httpError(403, 'candidateId may only be set by a trusted service caller or hr staff');
                }
            }

            // sha256 dedupe is scoped to the SAME owner context (audit H6).
            // A hash match against a document owned by someone else must never
            // reveal that document — a new row (+ new S3 object, since s3_key
            // is unique per row) is created under the uploader's ownership.
            const existing = await pool.query(
                `SELECT * FROM documents
                  WHERE sha256 = $1
                    AND owner_candidate_id IS NOT DISTINCT FROM $2
                    AND deleted_at IS NULL`,
                [sha256, candidateId]
            );
            if (existing.rows[0]) {
                return res.status(200).json({ ...rowToDocument(existing.rows[0]), deduplicated: true });
            }

            const id = randomUUID();
            const s3Key = `documents/${id}/${safeName}`;
            await putObject(s3, bucket, s3Key, req.file.buffer, mime);

            let inserted;
            try {
                inserted = await pool.query(
                    `INSERT INTO documents
                        (id, owner_candidate_id, kind, original_name, mime, size_bytes,
                         sha256, s3_key, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'uploaded')
                     RETURNING *`,
                    [id, candidateId, meta.data.kind, safeName, mime, req.file.size, sha256, s3Key]
                );
            } catch (err) {
                // Concurrent same-hash upload for the same owner — the winner
                // already inserted.
                if ((err as { code?: string }).code === '23505') {
                    await deleteObject(s3, bucket, s3Key).catch(() => undefined);
                    const winner = await pool.query(
                        `SELECT * FROM documents
                          WHERE sha256 = $1
                            AND owner_candidate_id IS NOT DISTINCT FROM $2
                            AND deleted_at IS NULL`,
                        [sha256, candidateId]
                    );
                    if (winner.rows[0]) {
                        return res.status(200).json({ ...rowToDocument(winner.rows[0]), deduplicated: true });
                    }
                }
                await deleteObject(s3, bucket, s3Key).catch(() => undefined);
                throw err;
            }

            await enqueue(pool, 'parse', { documentId: id });
            await publisher.publish(
                ResumeUploaded,
                'strafor.document.uploaded',
                {
                    documentId: id,
                    candidateId: candidateId ?? undefined,
                    kind: meta.data.kind,
                    s3Key,
                    mime,
                    sizeBytes: req.file.size,
                    sha256,
                    deduplicated: false
                },
                req.correlationId
            );

            res.status(201).json({ ...rowToDocument(inserted.rows[0]), deduplicated: false });
        } catch (err) {
            next(err);
        }
    });

    // All routes below operate on a single document id.
    const idParam = z.string().uuid();
    const parseId = (raw: string | undefined): string => {
        const parsed = idParam.safeParse(raw);
        if (!parsed.success) throw httpError(400, 'Invalid document id');
        return parsed.data;
    };

    router.get('/:id', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const doc = await loadDocument(pool, id);
            if (!doc) throw httpError(404, 'Document not found');
            authorize(doc, req.caller as Caller);
            res.json(rowToDocument(doc));
        } catch (err) {
            next(err);
        }
    });

    router.get('/:id/download', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const doc = await loadDocument(pool, id);
            if (!doc) throw httpError(404, 'Document not found');
            authorize(doc, req.caller as Caller);
            const url = await presignGetUrl(config, bucket, doc.s3_key, doc.original_name);
            res.json({ url, expiresInSeconds: config.PRESIGN_EXPIRES_SECONDS });
        } catch (err) {
            next(err);
        }
    });

    router.get('/:id/text', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const doc = await loadDocument(pool, id);
            if (!doc) throw httpError(404, 'Document not found');
            authorize(doc, req.caller as Caller);
            if (doc.status !== 'parsed') {
                throw httpError(404, `Document text not available (status: ${doc.status})`);
            }
            const { rows } = await pool.query(
                `SELECT extracted_text, page_count, extracted_at FROM document_texts WHERE document_id = $1`,
                [id]
            );
            if (!rows[0]) throw httpError(404, 'Document text not available');
            res.json({
                documentId: id,
                text: rows[0].extracted_text,
                pageCount: rows[0].page_count,
                extractedAt: rows[0].extracted_at
            });
        } catch (err) {
            next(err);
        }
    });

    router.delete('/:id', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const doc = await loadDocument(pool, id);
            if (!doc) throw httpError(404, 'Document not found');
            authorize(doc, req.caller as Caller);
            await pool.query(`UPDATE documents SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
            // S3 object removal is async — survives a crash via the jobs table.
            await enqueue(pool, 'delete-s3-object', { s3Key: doc.s3_key });
            log.info({ documentId: id }, 'document soft-deleted');
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    });

    router.post('/:id/reparse', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const doc = await loadDocument(pool, id);
            if (!doc) throw httpError(404, 'Document not found');
            authorize(doc, req.caller as Caller);
            await pool.query(
                `UPDATE documents SET status = 'parsing', error = NULL, updated_at = now() WHERE id = $1`,
                [id]
            );
            await enqueue(pool, 'parse', { documentId: id });
            res.status(202).json({ documentId: id, status: 'parsing' });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
