import type { Pool } from 'pg';
import type { S3Client } from '@aws-sdk/client-s3';
import { ResumeParsed } from '@strafor/contracts/events/document.js';
import type { ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';
import { deleteObject, getObjectBuffer } from './s3.js';
import { extractText } from './extraction.js';
import type { EventPublisher } from './events.js';

interface JobRow {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
}

export interface WorkerDeps {
    pool: Pool;
    s3: S3Client;
    bucket: string;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

/** Claim one queued job (SKIP LOCKED — safe for multiple replicas). */
async function claimJob(pool: Pool): Promise<JobRow | null> {
    const { rows } = await pool.query<JobRow>(
        `UPDATE jobs
            SET status = 'running', attempts = attempts + 1, updated_at = now()
          WHERE id = (
              SELECT id FROM jobs
               WHERE status = 'queued' AND run_at <= now()
               ORDER BY id
               FOR UPDATE SKIP LOCKED
               LIMIT 1
          )
          RETURNING id, type, payload, attempts`
    );
    return rows[0] ?? null;
}

async function reschedule(pool: Pool, jobId: string, attempts: number, error: string): Promise<void> {
    // Exponential backoff: 5s, 10s, 20s, 40s, ... capped at 5 minutes.
    const delayMs = Math.min(5000 * 2 ** (attempts - 1), 5 * 60 * 1000);
    await pool.query(
        `UPDATE jobs
            SET status = 'queued', run_at = now() + ($2 || ' milliseconds')::interval,
                error = $3, updated_at = now()
          WHERE id = $1`,
        [jobId, String(delayMs), error]
    );
}

async function failJob(pool: Pool, jobId: string, error: string): Promise<void> {
    await pool.query(`UPDATE jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [jobId, error]);
}

async function doneJob(pool: Pool, jobId: string): Promise<void> {
    await pool.query(`UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1`, [jobId]);
}

async function processParseJob(deps: WorkerDeps, job: JobRow): Promise<void> {
    const { pool, s3, bucket, config, publisher, log } = deps;
    const documentId = String(job.payload.documentId || '');

    const { rows } = await pool.query(
        `SELECT id, mime, s3_key, owner_candidate_id, deleted_at FROM documents WHERE id = $1`,
        [documentId]
    );
    const doc = rows[0];
    if (!doc || doc.deleted_at) {
        log.warn({ documentId }, 'parse job for missing/deleted document — dropping');
        return;
    }

    await pool.query(`UPDATE documents SET status = 'parsing', updated_at = now() WHERE id = $1`, [documentId]);

    const buffer = await getObjectBuffer(s3, bucket, doc.s3_key);
    const { text, pageCount } = await extractText(buffer, doc.mime);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO document_texts (document_id, extracted_text, page_count, extracted_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (document_id)
             DO UPDATE SET extracted_text = EXCLUDED.extracted_text,
                           page_count = EXCLUDED.page_count,
                           extracted_at = now()`,
            [documentId, text, pageCount ?? null]
        );
        await client.query(
            `UPDATE documents
                SET status = 'parsed', parse_version = $2, error = NULL, updated_at = now()
              WHERE id = $1`,
            [documentId, config.PARSE_VERSION]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    await publisher.publish(
        ResumeParsed,
        'strafor.document.parsed',
        {
            documentId,
            candidateId: doc.owner_candidate_id ?? undefined,
            kind: 'resume',
            chars: text.length,
            pageCount: pageCount ?? undefined,
            parseVersion: config.PARSE_VERSION
        },
        undefined
    );
    log.info({ documentId, chars: text.length }, 'document parsed');
}

async function processDeleteS3Job(deps: WorkerDeps, job: JobRow): Promise<void> {
    const { s3, bucket, log } = deps;
    const key = String(job.payload.s3Key || '');
    await deleteObject(s3, bucket, key);
    log.info({ s3Key: key }, 'S3 object deleted');
}

async function markDocumentFailed(pool: Pool, documentId: string, error: string): Promise<void> {
    await pool.query(`UPDATE documents SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [
        documentId,
        error
    ]);
}

/**
 * Claim and process the next queued job. Returns true when a job ran —
 * exported for deterministic tests.
 */
export async function processNextJob(deps: WorkerDeps): Promise<boolean> {
    const { pool, config, log } = deps;
    const job = await claimJob(pool);
    if (!job) return false;
    try {
        if (job.type === 'parse') await processParseJob(deps, job);
        else if (job.type === 'delete-s3-object') await processDeleteS3Job(deps, job);
        else throw new Error(`Unknown job type: ${job.type}`);
        await doneJob(pool, job.id);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, 'job failed');
        if (job.attempts >= config.JOB_MAX_ATTEMPTS) {
            await failJob(pool, job.id, message);
            if (job.type === 'parse') {
                await markDocumentFailed(pool, String(job.payload.documentId), message);
            }
        } else {
            await reschedule(pool, job.id, job.attempts, message);
        }
    }
    return true;
}

/**
 * In-process job worker backed by the `jobs` table. Polls with SKIP LOCKED;
 * parse failures reschedule with exponential backoff up to JOB_MAX_ATTEMPTS,
 * then the document is marked `failed`.
 */
export function startWorker(deps: WorkerDeps): { stop: () => void } {
    const { config, log } = deps;
    let running = true;
    let busy = false;

    const tick = async () => {
        if (!running || busy) return;
        busy = true;
        try {
            while (await processNextJob(deps)) {
                /* drain queue */
            }
        } catch (err) {
            log.error({ err: err instanceof Error ? err.message : err }, 'worker tick failed');
        } finally {
            busy = false;
        }
    };

    const timer = setInterval(() => void tick(), config.WORKER_POLL_MS);
    timer.unref();
    return {
        stop() {
            running = false;
            clearInterval(timer);
        }
    };
}

/** Re-queue jobs left 'running' by a crashed process. Call once at boot. */
export async function recoverStaleJobs(pool: Pool): Promise<void> {
    await pool.query(
        `UPDATE jobs SET status = 'queued', run_at = now(), updated_at = now()
          WHERE status = 'running'`
    );
}
