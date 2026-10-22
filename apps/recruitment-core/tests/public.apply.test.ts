// POST /v1/public/apply — ported from apps/api/tests/public.apply.test.js.
// Route layer under test; models + documents client are stubbed via vi.mock,
// the pool is a recording fake (withTransaction runs for real).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('../src/models/vacancy.js', () => ({
    find: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    softDeleteById: vi.fn()
}));

vi.mock('../src/models/candidate.js', () => ({
    normalizeEmail: (e: unknown) =>
        String(e || '')
            .trim()
            .toLowerCase(),
    findById: vi.fn(),
    findByEmail: vi.fn(),
    createWithVacancy: vi.fn()
}));

vi.mock('../src/serviceClient.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/serviceClient.js')>();
    return {
        ...orig,
        callService: vi.fn(),
        uploadDocument: vi.fn(),
        fetchDocumentDownload: vi.fn()
    };
});

import * as Vacancy from '../src/models/vacancy.js';
import * as Candidate from '../src/models/candidate.js';
import { uploadDocument } from '../src/serviceClient.js';
import { makeApp, makeDeps, makeFakeDb, makePublisher, testConfig, VALID_PDF, FAKE_PDF } from './helpers.js';

const baseFields = {
    first_name: 'Ana',
    last_name: 'Garcia',
    email: 'ana.garcia@example.com',
    phone: '+52 55 1234 5678',
    experience: '5',
    education: 'Bachelor',
    location: 'Mexico City, Mexico',
    skills: 'react, typescript',
    applied_for: '1'
};

let app: Express;

beforeAll(() => {
    const { pool } = makeFakeDb();
    app = makeApp(makeDeps({ pool, config: testConfig, publisher: makePublisher() }));
});

beforeEach(() => {
    vi.mocked(Vacancy.findById).mockReset().mockResolvedValue({ id: 1, title: 'Frontend Engineer' });
    vi.mocked(Candidate.createWithVacancy)
        .mockReset()
        .mockImplementation(async (_client, data: { first_name: string; last_name: string; email: string }) => ({
            id: 7,
            first_name: data.first_name,
            last_name: data.last_name,
            email: data.email,
            application_id: 42,
            status: 'pending',
            applied_at: new Date(),
            applied_for: { _id: '1', title: 'Frontend Engineer' }
        }));
    vi.mocked(uploadDocument).mockReset().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' });
});

describe('POST /v1/public/apply', () => {
    it('creates an application without a resume → 201', async () => {
        const res = await request(app).post('/v1/public/apply').field(baseFields);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ application_id: 42, message: 'Application received' });
        expect(Candidate.createWithVacancy).toHaveBeenCalled();
        const [clientArg, dataArg, optsArg] = vi.mocked(Candidate.createWithVacancy).mock.calls.at(-1)!;
        expect(clientArg).toBeTruthy(); // the tx client — events commit atomically
        expect(dataArg.applied_for).toBe(1); // coerced from string
        expect(dataArg.experience).toBe(5);
        expect(dataArg.resume_document_id).toBeNull();
        expect(optsArg).toEqual({ createdBy: null });
    });

    it('accepts a real PDF resume and forwards it to documents-resumes → 201', async () => {
        const res = await request(app).post('/v1/public/apply').field(baseFields).attach('resume', VALID_PDF, 'cv.pdf');
        expect(res.status).toBe(201);
        expect(uploadDocument).toHaveBeenCalledTimes(1);
        const [baseUrl, file, opts] = vi.mocked(uploadDocument).mock.calls[0]!;
        expect(baseUrl).toBe(testConfig.DOCUMENTS_URL);
        expect(file.mime).toBe('application/pdf');
        expect(opts.serviceToken).toBe(testConfig.SERVICE_AUTH_TOKEN);
        const [, dataArg] = vi.mocked(Candidate.createWithVacancy).mock.calls.at(-1)!;
        expect(dataArg.resume_document_id).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('rejects a renamed executable as resume → 415 (never reaches documents)', async () => {
        const res = await request(app)
            .post('/v1/public/apply')
            .field(baseFields)
            .attach('resume', FAKE_PDF, 'evil.pdf');
        expect(res.status).toBe(415);
        expect(uploadDocument).not.toHaveBeenCalled();
        expect(Candidate.createWithVacancy).not.toHaveBeenCalled();
    });

    it('rejects a disallowed extension → 415', async () => {
        const res = await request(app)
            .post('/v1/public/apply')
            .field(baseFields)
            .attach('resume', VALID_PDF, 'evil.exe');
        expect(res.status).toBe(415);
        expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('rejects a missing required field → 400', async () => {
        const { email: _email, ...noEmail } = baseFields;
        void _email;
        const res = await request(app).post('/v1/public/apply').field(noEmail).attach('resume', VALID_PDF, 'cv.pdf');
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('details');
        expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric vacancy id → 400', async () => {
        const res = await request(app)
            .post('/v1/public/apply')
            .field({ ...baseFields, applied_for: 'abc' });
        expect(res.status).toBe(400);
    });

    it('returns 404 when the vacancy does not exist', async () => {
        vi.mocked(Vacancy.findById).mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/public/apply').field(baseFields);
        expect(res.status).toBe(404);
    });

    it('maps the (candidate, vacancy) unique conflict to an idempotent 200', async () => {
        vi.mocked(Candidate.createWithVacancy).mockRejectedValueOnce(
            Object.assign(new Error('duplicate'), { code: '23505' })
        );
        const res = await request(app).post('/v1/public/apply').field(baseFields);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ message: 'Application already received' });
    });

    it('maps an FK violation to 404', async () => {
        vi.mocked(Candidate.createWithVacancy).mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
        const res = await request(app).post('/v1/public/apply').field(baseFields);
        expect(res.status).toBe(404);
    });

    it('requires no authentication', async () => {
        const res = await request(app).post('/v1/public/apply').field(baseFields);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
    });

    it('enqueues both event families inside the transaction', async () => {
        const { pool, client } = makeFakeDb();
        const localApp = makeApp(makeDeps({ pool }));
        const res = await request(localApp).post('/v1/public/apply').field(baseFields);
        expect(res.status).toBe(201);
        const outboxInserts = client.calls
            .filter((c) => c.sql.toLowerCase().includes('insert into outbox_events'))
            .map((c) => c.params[0]);
        expect(outboxInserts).toEqual(
            expect.arrayContaining(['strafor.recruitment.application_submitted', 'strafor.application.submitted'])
        );
    });

    it('rate-limits after 20 requests/hour/IP → 429', async () => {
        let saw429 = false;
        for (let i = 0; i < 15; i++) {
            const res = await request(app).post('/v1/public/apply').send({});
            if (res.status === 429) {
                saw429 = true;
                break;
            }
            expect([400, 429]).toContain(res.status);
        }
        expect(saw429).toBe(true);
    });
});
