// Privacy-audit regression tests (C1 admin access, H1 forgeable
// X-Candidate-Id, H6 cross-candidate sha256 dedupe). Runs without real
// Postgres/MinIO — the pool and S3 client are faked at the seam used by the
// route handlers.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool, QueryResult } from 'pg';
import { DeleteObjectCommand, HeadBucketCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createApp } from '../src/app.js';
import { loadConfig, type ServiceConfig } from '../src/config.js';
import type { EventPublisher } from '../src/events.js';
import { makePdf } from './helpers.js';

const SERVICE_TOKEN = 'test-service-token';

const SVC = { 'X-Service-Token': SERVICE_TOKEN };
const ADMIN = { 'X-User-Id': '1', 'X-User-Role': 'admin' };
const HR = { 'X-User-Id': '7', 'X-User-Role': 'hr' };
/** Trusted caller asserting a verified candidate identity. */
const svcCandidate = (cid: number, userId = 9) => ({
    ...SVC,
    'X-User-Id': String(userId),
    'X-User-Role': 'candidate',
    'X-Candidate-Id': String(cid)
});
/** Browser-auth candidate — X-Candidate-Id is client-forgeable here. */
const userCandidate = (cid: number, userId = 9) => ({
    'X-User-Id': String(userId),
    'X-User-Role': 'candidate',
    'X-Candidate-Id': String(cid)
});

const silentLog = new Proxy({} as never, {
    get: () => () => {}
}) as import('@strafor/node-common').ServiceLogger;

const fakePublisher: EventPublisher = {
    publish: async () => true,
    close: async () => {}
};

interface DocRow {
    id: string;
    owner_candidate_id: number | null;
    kind: string;
    original_name: string;
    mime: string;
    size_bytes: number;
    sha256: string;
    s3_key: string;
    status: string;
    parse_version: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
}

/** Minimal in-memory stand-in for pg.Pool covering the route queries. */
class FakePool {
    docs = new Map<string, DocRow>();
    texts = new Map<string, { extracted_text: string; page_count: number | null; extracted_at: string }>();
    jobs: Array<{ type: string; payload: unknown }> = [];

    seed(doc: Partial<DocRow> & { id?: string } = {}): DocRow {
        const row: DocRow = {
            id: doc.id ?? randomUUID(),
            owner_candidate_id: doc.owner_candidate_id ?? null,
            kind: doc.kind ?? 'resume',
            original_name: doc.original_name ?? 'cv.pdf',
            mime: doc.mime ?? 'application/pdf',
            size_bytes: doc.size_bytes ?? 100,
            sha256: doc.sha256 ?? randomUUID(),
            s3_key: doc.s3_key ?? `documents/${doc.id ?? 'x'}/cv.pdf`,
            status: doc.status ?? 'parsed',
            parse_version: doc.parse_version ?? '1',
            error: doc.error ?? null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: doc.deleted_at ?? null
        };
        this.docs.set(row.id, row);
        return row;
    }

    async query(text: string, params: unknown[] = []): Promise<QueryResult> {
        const sql = text.replace(/\s+/g, ' ').trim();

        if (sql.startsWith('INSERT INTO jobs')) {
            this.jobs.push({ type: params[0] as string, payload: JSON.parse(params[1] as string) });
            return { rows: [] } as QueryResult;
        }
        if (sql.startsWith('SELECT * FROM documents WHERE sha256')) {
            const [sha256, owner] = params as [string, number | null];
            const row = [...this.docs.values()].find(
                (d) => d.sha256 === sha256 && d.owner_candidate_id === (owner ?? null) && d.deleted_at === null
            );
            return { rows: row ? [row] : [] } as QueryResult;
        }
        if (sql.startsWith('INSERT INTO documents')) {
            const [id, owner, kind, name, mime, size, sha256, s3Key] = params as [
                string,
                number | null,
                string,
                string,
                string,
                number,
                string,
                string
            ];
            // Emulates documents_sha256_owner_live_uidx (migration 0002).
            const clash = [...this.docs.values()].find(
                (d) => d.sha256 === sha256 && (d.owner_candidate_id ?? 0) === (owner ?? 0) && d.deleted_at === null
            );
            if (clash) {
                const err = new Error('duplicate key value violates unique constraint');
                (err as { code?: string }).code = '23505';
                throw err;
            }
            const row: DocRow = {
                id,
                owner_candidate_id: owner,
                kind,
                original_name: name,
                mime,
                size_bytes: size,
                sha256,
                s3_key: s3Key,
                status: 'uploaded',
                parse_version: null,
                error: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                deleted_at: null
            };
            this.docs.set(id, row);
            return { rows: [row] } as QueryResult;
        }
        if (sql.startsWith('SELECT * FROM documents WHERE id')) {
            const row = this.docs.get(params[0] as string);
            return { rows: row && row.deleted_at === null ? [row] : [] } as QueryResult;
        }
        if (sql.startsWith('UPDATE documents SET deleted_at')) {
            const row = this.docs.get(params[0] as string);
            if (row) row.deleted_at = new Date().toISOString();
            return { rows: [] } as QueryResult;
        }
        if (sql.startsWith('UPDATE documents SET status')) {
            const row = this.docs.get(params[0] as string);
            if (row) row.status = 'parsing';
            return { rows: [] } as QueryResult;
        }
        if (sql.startsWith('SELECT extracted_text')) {
            const t = this.texts.get(params[0] as string);
            return { rows: t ? [t] : [] } as QueryResult;
        }
        throw new Error(`FakePool: unexpected query: ${sql}`);
    }
}

function makeFakeS3(objects: Map<string, Buffer>): S3Client {
    return {
        send: async (cmd: unknown) => {
            if (cmd instanceof PutObjectCommand) {
                objects.set(cmd.input.Key as string, Buffer.from(cmd.input.Body as Buffer));
                return {};
            }
            if (cmd instanceof DeleteObjectCommand) {
                objects.delete(cmd.input.Key as string);
                return {};
            }
            if (cmd instanceof HeadBucketCommand) return {};
            throw new Error('FakeS3: unexpected command');
        }
    } as unknown as S3Client;
}

describe('document privacy ACL (audit C1/H1/H6)', () => {
    let pool: FakePool;
    let objects: Map<string, Buffer>;
    let app: Express;
    let config: ServiceConfig;

    beforeEach(() => {
        pool = new FakePool();
        objects = new Map();
        config = loadConfig({
            DATABASE_URL: 'postgres://postgres:dev@localhost:55433/strafor_documents',
            MINIO_ENDPOINT: 'localhost',
            MINIO_PORT: '59000',
            MINIO_ACCESS_KEY: 'dev',
            MINIO_SECRET_KEY: 'devdevdev',
            SERVICE_AUTH_TOKEN: SERVICE_TOKEN
        });
        app = createApp({
            pool: pool as unknown as Pool,
            s3: makeFakeS3(objects),
            bucket: 'test-documents',
            config,
            publisher: fakePublisher,
            log: silentLog
        });
    });

    it('rejects requests with no credentials (401)', async () => {
        const res = await request(app).get(`/v1/documents/${randomUUID()}`);
        expect(res.status).toBe(401);
    });

    it('rejects a bad service token without user headers (401)', async () => {
        const res = await request(app).get(`/v1/documents/${randomUUID()}`).set({ 'X-Service-Token': 'wrong-token' });
        expect(res.status).toBe(401);
    });

    it('admin is denied on every document content path', async () => {
        const doc = pool.seed({ owner_candidate_id: 42 });
        pool.texts.set(doc.id, { extracted_text: 'secret resume', page_count: 1, extracted_at: 'now' });

        for (const [method, path] of [
            ['get', `/v1/documents/${doc.id}`],
            ['get', `/v1/documents/${doc.id}/download`],
            ['get', `/v1/documents/${doc.id}/text`],
            ['delete', `/v1/documents/${doc.id}`],
            ['post', `/v1/documents/${doc.id}/reparse`]
        ] as const) {
            const res = await request(app)[method](path).set(ADMIN);
            expect(res.status, `${method.toUpperCase()} ${path}`).toBe(403);
        }

        // No list-of-candidate-docs route exists — admin can't even probe it.
        const list = await request(app).get('/v1/documents?candidateId=42').set(ADMIN);
        expect(list.status).toBe(403);
        expect(list.body).not.toHaveProperty('documents');

        // Upload paths are closed to admin too (with or without candidateId).
        const up1 = await request(app).post('/v1/documents').set(ADMIN).attach('file', makePdf('a'), 'a.pdf');
        expect(up1.status).toBe(403);
        const up2 = await request(app)
            .post('/v1/documents')
            .set(ADMIN)
            .field('candidateId', '42')
            .attach('file', makePdf('b'), 'b.pdf');
        expect(up2.status).toBe(403);
    });

    it('admin stays denied even when asserted by a trusted service caller', async () => {
        const doc = pool.seed({ owner_candidate_id: 42 });
        const res = await request(app)
            .get(`/v1/documents/${doc.id}`)
            .set({ ...SVC, ...ADMIN });
        expect(res.status).toBe(403);
    });

    it('hr retains full document access', async () => {
        const doc = pool.seed({ owner_candidate_id: 42 });
        pool.texts.set(doc.id, { extracted_text: 'resume text', page_count: 2, extracted_at: 'now' });

        expect((await request(app).get(`/v1/documents/${doc.id}`).set(HR)).status).toBe(200);
        const dl = await request(app).get(`/v1/documents/${doc.id}/download`).set(HR);
        expect(dl.status).toBe(200);
        expect(dl.body.url).toContain('X-Amz-Signature=');
        const text = await request(app).get(`/v1/documents/${doc.id}/text`).set(HR);
        expect(text.status).toBe(200);
        expect(text.body.text).toBe('resume text');
        expect((await request(app).post(`/v1/documents/${doc.id}/reparse`).set(HR)).status).toBe(202);
        expect((await request(app).delete(`/v1/documents/${doc.id}`).set(HR)).status).toBe(204);
    });

    it('pure service callers (no user headers) can read documents', async () => {
        const doc = pool.seed({ owner_candidate_id: 42 });
        const res = await request(app).get(`/v1/documents/${doc.id}`).set(SVC);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(doc.id);
    });

    it('service-asserted candidate can access own docs, not foreign docs', async () => {
        const own = pool.seed({ owner_candidate_id: 42 });
        const foreign = pool.seed({ owner_candidate_id: 99 });

        expect((await request(app).get(`/v1/documents/${own.id}`).set(svcCandidate(42))).status).toBe(200);
        expect((await request(app).get(`/v1/documents/${own.id}/download`).set(svcCandidate(42))).status).toBe(200);
        expect((await request(app).get(`/v1/documents/${foreign.id}`).set(svcCandidate(42))).status).toBe(403);

        // X-Candidate-Id asserted alone by a trusted caller still scopes access.
        const scoped = await request(app)
            .get(`/v1/documents/${own.id}`)
            .set({ ...SVC, 'X-Candidate-Id': '42' });
        expect(scoped.status).toBe(200);
        const scopedForeign = await request(app)
            .get(`/v1/documents/${foreign.id}`)
            .set({ ...SVC, 'X-Candidate-Id': '42' });
        expect(scopedForeign.status).toBe(403);
    });

    it('user-auth X-Candidate-Id is ignored — forged ownership claims get 403', async () => {
        const doc = pool.seed({ owner_candidate_id: 42 });
        // Same user id + forged candidate claim, but NO service token.
        const res = await request(app).get(`/v1/documents/${doc.id}`).set(userCandidate(42));
        expect(res.status).toBe(403);
        // A bad service token does not make the claim trustworthy either.
        const badToken = await request(app)
            .get(`/v1/documents/${doc.id}`)
            .set({ ...userCandidate(42), 'X-Service-Token': 'wrong-token' });
        expect(badToken.status).toBe(403);
    });

    it('user-auth uploads may not attach a candidateId; service and hr may', async () => {
        // Browser-auth candidate forging an owner → denied.
        const forged = await request(app)
            .post('/v1/documents')
            .set(userCandidate(42))
            .field('candidateId', '42')
            .attach('file', makePdf('mine'), 'mine.pdf');
        expect(forged.status).toBe(403);

        // Trusted service caller may assert any candidateId.
        const svc = await request(app)
            .post('/v1/documents')
            .set(SVC)
            .field('candidateId', '42')
            .attach('file', makePdf('via service'), 'svc.pdf');
        expect(svc.status).toBe(201);
        expect(svc.body.candidateId).toBe(42);

        // Service-asserted candidate context applies as the owner by default.
        const svcOwn = await request(app)
            .post('/v1/documents')
            .set(svcCandidate(55))
            .attach('file', makePdf('auto owner'), 'own.pdf');
        expect(svcOwn.status).toBe(201);
        expect(svcOwn.body.candidateId).toBe(55);

        // Verified hr staff keep the ability to upload on a candidate's behalf.
        const hr = await request(app)
            .post('/v1/documents')
            .set(HR)
            .field('candidateId', '77')
            .attach('file', makePdf('hr upload'), 'hr.pdf');
        expect(hr.status).toBe(201);
        expect(hr.body.candidateId).toBe(77);
    });

    it('sha256 dedupe is scoped by owner — foreign hash match creates a new doc', async () => {
        const pdf = makePdf('identical bytes across candidates');

        const a = await request(app)
            .post('/v1/documents')
            .set(SVC)
            .field('candidateId', '42')
            .attach('file', pdf, 'alice-cv.pdf');
        expect(a.status).toBe(201);
        const idA = a.body.id as string;
        const keyA = a.body.s3Key as string;

        // Same bytes, different owner → NEW row/id, NEW s3 key, own metadata.
        const b = await request(app)
            .post('/v1/documents')
            .set(SVC)
            .field('candidateId', '99')
            .attach('file', pdf, 'bob-cv.pdf');
        expect(b.status).toBe(201);
        expect(b.body.deduplicated).toBe(false);
        expect(b.body.id).not.toBe(idA);
        expect(b.body.candidateId).toBe(99); // never reveals owner 42
        expect(b.body.originalName).toBe('bob-cv.pdf'); // not the foreign name
        expect(b.body.s3Key).not.toBe(keyA); // distinct key → delete-safe

        // Same bytes, same owner → dedupe hit.
        const a2 = await request(app)
            .post('/v1/documents')
            .set(SVC)
            .field('candidateId', '42')
            .attach('file', pdf, 'again.pdf');
        expect(a2.status).toBe(200);
        expect(a2.body.deduplicated).toBe(true);
        expect(a2.body.id).toBe(idA);

        // Same bytes, no owner → separate null-owner scope, new row.
        const c = await request(app).post('/v1/documents').set(HR).attach('file', pdf, 'anon.pdf');
        expect(c.status).toBe(201);
        expect(c.body.id).not.toBe(idA);

        // Deleting doc B removes only B's object; A's object survives.
        await request(app).delete(`/v1/documents/${b.body.id}`).set(SVC);
        expect(
            pool.jobs.some(
                (j) => j.type === 'delete-s3-object' && (j.payload as { s3Key: string }).s3Key === b.body.s3Key
            )
        ).toBe(true);
        expect(objects.has(keyA)).toBe(true);
    });
});
