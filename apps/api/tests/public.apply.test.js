// Public apply endpoint tests: POST /api/public/apply.
// Runs WITHOUT a live database — Candidate/Vacancy model methods and the audit
// writer are stubbed on the shared CJS module objects before the app is
// imported, and the app's db-connected guard is bypassed via setDbConnected.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// Isolate resume uploads in a temp dir; routes/public.js resolves RESUMES_DIR
// at module load, so this must be set BEFORE the server is imported.
const tmpResumes = fs.mkdtempSync(path.join(os.tmpdir(), 'strafor-public-apply-'));
process.env.RESUMES_DIR = tmpResumes;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-vitest';

const Candidate = require('../models/Candidate');
const Vacancy = require('../models/Vacancy');
const audit = require('../utils/audit');

const VALID_PDF = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(64)]);
const FAKE_PDF = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]); // MZ exe

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

let app;

function countStoredResumes() {
    return fs.readdirSync(tmpResumes).filter((f) => f.startsWith('resume_')).length;
}

beforeAll(async () => {
    // Stub the DB-touching seams; the route layer is what is under test.
    Vacancy.findById = vi.fn(async () => ({ id: 1, title: 'Frontend Engineer' }));
    Candidate.createWithVacancy = vi.fn(async (data) => ({
        id: 7,
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        application_id: 42,
        status: 'pending',
        applied_for: { _id: '1', title: 'Frontend Engineer' }
    }));
    audit.record = vi.fn(async () => {});

    const server = await import('../server.js');
    app = server.app;
    server.setDbConnected(true); // bypass the 503 DB guard
});

afterAll(() => {
    fs.rmSync(tmpResumes, { recursive: true, force: true });
});

describe('POST /api/public/apply', () => {
    it('creates an application without a resume → 201', async () => {
        const res = await request(app).post('/api/public/apply').field(baseFields);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ application_id: 42, message: 'Application received' });
        expect(Candidate.createWithVacancy).toHaveBeenCalled();
        const [dataArg, optsArg] = Candidate.createWithVacancy.mock.calls.at(-1);
        expect(dataArg.applied_for).toBe(1); // coerced from string
        expect(dataArg.experience).toBe(5);
        expect(dataArg.resume).toBeUndefined();
        expect(optsArg).toEqual({ createdBy: null });
    });

    it('accepts a real PDF resume and stores it under a generated name → 201', async () => {
        const res = await request(app)
            .post('/api/public/apply')
            .field(baseFields)
            .attach('resume', VALID_PDF, 'cv.pdf');
        expect(res.status).toBe(201);
        expect(countStoredResumes()).toBe(1);
        const [dataArg] = Candidate.createWithVacancy.mock.calls.at(-1);
        expect(dataArg.resume).toMatch(/^resume_.*\.pdf$/);
    });

    it('rejects a renamed executable as resume → 415 and deletes the file', async () => {
        const before = countStoredResumes();
        const res = await request(app)
            .post('/api/public/apply')
            .field(baseFields)
            .attach('resume', FAKE_PDF, 'evil.pdf');
        expect(res.status).toBe(415);
        expect(countStoredResumes()).toBe(before);
    });

    it('rejects a disallowed extension → 415', async () => {
        const res = await request(app)
            .post('/api/public/apply')
            .field(baseFields)
            .attach('resume', VALID_PDF, 'evil.exe');
        expect(res.status).toBe(415);
    });

    it('rejects a missing required field → 400 and cleans up the upload', async () => {
        const before = countStoredResumes();
        const { email: _email, ...noEmail } = baseFields;
        const res = await request(app).post('/api/public/apply').field(noEmail).attach('resume', VALID_PDF, 'cv.pdf');
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('details');
        expect(countStoredResumes()).toBe(before);
    });

    it('rejects a non-numeric vacancy id → 400', async () => {
        const res = await request(app)
            .post('/api/public/apply')
            .field({ ...baseFields, applied_for: 'abc' });
        expect(res.status).toBe(400);
    });

    it('returns 404 when the vacancy does not exist', async () => {
        Vacancy.findById.mockResolvedValueOnce(null);
        const res = await request(app).post('/api/public/apply').field(baseFields);
        expect(res.status).toBe(404);
    });

    it('maps the (candidate, vacancy) unique conflict to an idempotent 200', async () => {
        Candidate.createWithVacancy.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
        const res = await request(app).post('/api/public/apply').field(baseFields);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ message: 'Application already received' });
    });

    it('requires no authentication', async () => {
        const res = await request(app).post('/api/public/apply').field(baseFields);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
    });

    it('rate-limits after 20 requests/hour/IP → 429', async () => {
        // ~10 requests have already hit the limiter above; exhaust the rest.
        let saw429 = false;
        for (let i = 0; i < 15; i++) {
            const res = await request(app).post('/api/public/apply').send({});
            if (res.status === 429) {
                saw429 = true;
                break;
            }
            expect([400, 429]).toContain(res.status);
        }
        expect(saw429).toBe(true);
    });
});
