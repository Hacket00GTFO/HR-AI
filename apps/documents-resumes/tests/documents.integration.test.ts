import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { runner } from 'node-pg-migrate';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { S3Client } from '@aws-sdk/client-s3';
import { createPool } from '../src/db.js';
import { loadConfig, type ServiceConfig } from '../src/config.js';
import { createS3Client, ensureBucket } from '../src/s3.js';
import { createApp } from '../src/app.js';
import { processNextJob, recoverStaleJobs } from '../src/worker.js';
import type { EventPublisher } from '../src/events.js';
import { makeDocx, makePdf } from './helpers.js';

// Gated on real infra — `vitest` passes cleanly with no containers running.
const RUN =
    process.env.TEST_DATABASE_URL &&
    process.env.TEST_MINIO_ENDPOINT &&
    process.env.TEST_MINIO_ACCESS_KEY &&
    process.env.TEST_MINIO_SECRET_KEY;

const silentLog = new Proxy({} as never, {
    get: () => () => {}
}) as import('@strafor/node-common').ServiceLogger;

const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
const fakePublisher: EventPublisher = {
    publish: async (_schema, type, payload) => {
        published.push({ type, payload });
        return true;
    },
    close: async () => {}
};

describe.skipIf(!RUN)('documents-resumes integration (needs TEST_DATABASE_URL + TEST_MINIO_*)', () => {
    let pool: Pool;
    let s3: S3Client;
    let config: ServiceConfig;
    let app: Express;

    const HR = { 'X-User-Id': '7', 'X-User-Role': 'hr' };
    const SVC = { 'X-Service-Token': 'test-service-token' };
    // Trusted caller asserting a verified candidate identity on a user's behalf.
    const svcCandidate = (cid: number) => ({
        ...SVC,
        'X-User-Id': '9',
        'X-User-Role': 'candidate',
        'X-Candidate-Id': String(cid)
    });

    beforeAll(async () => {
        const env = {
            ...process.env,
            DATABASE_URL: process.env.TEST_DATABASE_URL,
            MINIO_ENDPOINT: new URL(process.env.TEST_MINIO_ENDPOINT as string).hostname,
            MINIO_PORT: new URL(process.env.TEST_MINIO_ENDPOINT as string).port,
            MINIO_USE_SSL: 'false',
            MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY,
            MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY,
            MINIO_BUCKET: 'test-documents',
            MINIO_AUTOCREATE: 'true',
            RABBITMQ_URL: '',
            SERVICE_AUTH_TOKEN: 'test-service-token'
        } as Record<string, string>;
        config = loadConfig(env);
        pool = createPool(config.DATABASE_URL);
        s3 = createS3Client(config);

        await runner({
            databaseUrl: config.DATABASE_URL,
            dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations'),
            direction: 'up',
            migrationsTable: 'pgmigrations',
            migrationsSchema: 'public',
            schema: 'public',
            count: Infinity,
            log: () => {}
        });
        await pool.query('TRUNCATE jobs, document_texts, documents CASCADE');
        await ensureBucket(s3, config.MINIO_BUCKET, true, silentLog);
        await recoverStaleJobs(pool);

        app = createApp({
            pool,
            s3,
            bucket: config.MINIO_BUCKET,
            config,
            publisher: fakePublisher,
            log: silentLog
        });
    });

    afterAll(async () => {
        await pool.end();
    });

    it('rejects requests without identity headers', async () => {
        const res = await request(app).post('/v1/documents').attach('file', makePdf('x'), 'cv.pdf');
        expect(res.status).toBe(401);
        expect(res.body.error).toBeTruthy();
    });

    it('uploads a PDF, dedupes by sha256, parses it, serves text + presigned URL', async () => {
        const pdf = makePdf('StraforAI resume extraction works');

        const up = await request(app)
            .post('/v1/documents')
            .set(HR)
            .field('candidateId', '42')
            .attach('file', pdf, 'jane-cv.pdf');
        expect(up.status).toBe(201);
        expect(up.body.deduplicated).toBe(false);
        expect(up.body.status).toBe('uploaded');
        expect(up.body.candidateId).toBe(42);
        const id = up.body.id as string;

        // identical content for the SAME owner → dedupe (audit H6)
        const dup = await request(app)
            .post('/v1/documents')
            .set(HR)
            .field('candidateId', '42')
            .attach('file', pdf, 'renamed-copy.pdf');
        expect(dup.status).toBe(200);
        expect(dup.body.deduplicated).toBe(true);
        expect(dup.body.id).toBe(id);

        // text not ready yet
        const early = await request(app).get(`/v1/documents/${id}/text`).set(HR);
        expect(early.status).toBe(404);

        // run the parse job deterministically
        expect(
            await processNextJob({
                pool,
                s3,
                bucket: config.MINIO_BUCKET,
                config,
                publisher: fakePublisher,
                log: silentLog
            })
        ).toBe(true);

        const meta = await request(app).get(`/v1/documents/${id}`).set(HR);
        expect(meta.status).toBe(200);
        expect(meta.body.status).toBe('parsed');

        const text = await request(app).get(`/v1/documents/${id}/text`).set(HR);
        expect(text.status).toBe(200);
        expect(text.body.text).toContain('StraforAI resume extraction works');

        const dl = await request(app).get(`/v1/documents/${id}/download`).set(HR);
        expect(dl.status).toBe(200);
        expect(dl.body.url).toContain('X-Amz-Signature=');
        expect(dl.body.expiresInSeconds).toBe(900);

        const types = published.map((e) => e.type);
        expect(types).toContain('strafor.document.uploaded');
        expect(types).toContain('strafor.document.parsed');
        const parsedEvt = published.find((e) => e.type === 'strafor.document.parsed');
        expect(parsedEvt?.payload.chars).toBeGreaterThan(0);
        expect(parsedEvt?.payload.candidateId).toBe(42);

        // soft delete → 404 afterwards
        const del = await request(app).delete(`/v1/documents/${id}`).set(HR);
        expect(del.status).toBe(204);
        const gone = await request(app).get(`/v1/documents/${id}`).set(HR);
        expect(gone.status).toBe(404);
        // async s3 delete job runs
        expect(
            await processNextJob({
                pool,
                s3,
                bucket: config.MINIO_BUCKET,
                config,
                publisher: fakePublisher,
                log: silentLog
            })
        ).toBe(true);
    });

    it('uploads a DOCX and extracts text', async () => {
        const docx = makeDocx('DOCX extraction also works');
        const up = await request(app).post('/v1/documents').set(HR).attach('file', docx, 'cv.docx');
        expect(up.status).toBe(201);
        const id = up.body.id as string;

        expect(
            await processNextJob({
                pool,
                s3,
                bucket: config.MINIO_BUCKET,
                config,
                publisher: fakePublisher,
                log: silentLog
            })
        ).toBe(true);

        const text = await request(app).get(`/v1/documents/${id}/text`).set(HR);
        expect(text.status).toBe(200);
        expect(text.body.text).toContain('DOCX extraction also works');
    });

    it('rejects an executable masquerading as a PDF (415)', async () => {
        const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(128, 0x90)]);
        const res = await request(app).post('/v1/documents').set(HR).attach('file', exe, 'totally-a-cv.pdf');
        expect(res.status).toBe(415);
    });

    it('rejects files over the size limit (413)', async () => {
        const big = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(11 * 1024 * 1024, 0x20)]);
        const res = await request(app).post('/v1/documents').set(HR).attach('file', big, 'huge.pdf');
        expect(res.status).toBe(413);
    });

    it('enforces ownership; admin denied; X-Candidate-Id needs a service token', async () => {
        const pdf = makePdf('owned doc');
        // Trusted service caller may attach the upload to a candidate.
        const up = await request(app).post('/v1/documents').set(svcCandidate(42)).attach('file', pdf, 'mine.pdf');
        expect(up.status).toBe(201);
        expect(up.body.candidateId).toBe(42);
        const id = up.body.id as string;

        // Foreign candidate asserted by a trusted caller → 403.
        const other = await request(app).get(`/v1/documents/${id}`).set(svcCandidate(99));
        expect(other.status).toBe(403);

        // Owner asserted by a trusted caller → allowed.
        const own = await request(app).get(`/v1/documents/${id}`).set(svcCandidate(42));
        expect(own.status).toBe(200);

        // Client-forged X-Candidate-Id (no service token) → claim ignored → 403.
        const forged = await request(app)
            .get(`/v1/documents/${id}`)
            .set({ 'X-User-Id': '9', 'X-User-Role': 'candidate', 'X-Candidate-Id': '42' });
        expect(forged.status).toBe(403);

        // Platform admin never reads business content (audit C1).
        const admin = await request(app).get(`/v1/documents/${id}`).set({ 'X-User-Id': '1', 'X-User-Role': 'admin' });
        expect(admin.status).toBe(403);
    });

    it('reparse re-enqueues extraction', async () => {
        const pdf = makePdf('reparse me');
        const up = await request(app).post('/v1/documents').set(HR).attach('file', pdf, 'reparse.pdf');
        const id = up.body.id as string;

        const re = await request(app).post(`/v1/documents/${id}/reparse`).set(HR);
        expect(re.status).toBe(202);
        expect(re.body.status).toBe('parsing');

        // Drain the queue — earlier tests may have left jobs queued, and
        // claimJob is FIFO so a single call would process those first.
        const deps = { pool, s3, bucket: config.MINIO_BUCKET, config, publisher: fakePublisher, log: silentLog };
        while (await processNextJob(deps)) {
            /* keep draining */
        }
        const text = await request(app).get(`/v1/documents/${id}/text`).set(HR);
        expect(text.status).toBe(200);
        expect(text.body.text).toContain('reparse me');
    });
});
