// cover_letter — accepted on POST /v1/public/apply (+ POST /v1/candidates),
// persisted on applications.cover_letter, returned only on HR-facing
// application detail surfaces, never in public responses or event payloads.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('../src/models/vacancy.js', () => ({
    find: vi.fn(),
    findById: vi.fn(),
    findOpen: vi.fn(),
    create: vi.fn(),
    softDeleteById: vi.fn(),
    normalizeStatus: (s: unknown) => s
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

vi.mock('../src/models/application.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/models/application.js')>();
    return {
        ...orig,
        findById: vi.fn(),
        findDetailById: vi.fn(),
        findDetailedByVacancy: vi.fn()
    };
});

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
import * as Application from '../src/models/application.js';
import { makeApp, makeDeps, makeFakeDb, HR_HEADERS } from './helpers.js';
import type { Queryable } from '../src/db.js';

// The mocked module keeps the real implementations we didn't override, but
// grab the pristine module for the model-level persistence assertions.
let RealApplication: typeof Application;

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

beforeAll(async () => {
    RealApplication = await vi.importActual<typeof Application>('../src/models/application.js');
    const { pool } = makeFakeDb();
    app = makeApp(makeDeps({ pool }));
});

beforeEach(() => {
    vi.mocked(Vacancy.findById).mockReset().mockResolvedValue({ id: 1, title: 'Frontend Engineer' });
    vi.mocked(Candidate.createWithVacancy)
        .mockReset()
        .mockImplementation(async (_client, data: Record<string, unknown>) => ({
            id: 7,
            ...data,
            application_id: 42,
            status: 'pending',
            applied_at: new Date(),
            applied_for: { _id: '1', title: 'Frontend Engineer' }
        }));
});

describe('cover_letter on POST /v1/public/apply', () => {
    it('is accepted and forwarded into the application create data', async () => {
        const res = await request(app)
            .post('/v1/public/apply')
            .field({ ...baseFields, cover_letter: 'I love building UIs.' });
        expect(res.status).toBe(201);
        const [, dataArg] = vi.mocked(Candidate.createWithVacancy).mock.calls.at(-1)!;
        expect(dataArg.cover_letter).toBe('I love building UIs.');
    });

    it('is optional and stays absent when not sent', async () => {
        const res = await request(app).post('/v1/public/apply').field(baseFields);
        expect(res.status).toBe(201);
        const [, dataArg] = vi.mocked(Candidate.createWithVacancy).mock.calls.at(-1)!;
        expect(dataArg.cover_letter).toBeUndefined();
    });

    it('rejects letters over 10k chars → 400', async () => {
        const res = await request(app)
            .post('/v1/public/apply')
            .field({ ...baseFields, cover_letter: 'x'.repeat(10001) });
        expect(res.status).toBe(400);
        expect(Candidate.createWithVacancy).not.toHaveBeenCalled();
    });

    it('never leaks into the public response body', async () => {
        const res = await request(app)
            .post('/v1/public/apply')
            .field({ ...baseFields, cover_letter: 'private letter' });
        expect(res.status).toBe(201);
        expect(res.body).not.toHaveProperty('cover_letter');
        expect(JSON.stringify(res.body)).not.toContain('private letter');
    });

    it('stays out of the outbox event payloads (PII must not hit the bus)', async () => {
        const { pool, client } = makeFakeDb();
        const localApp = makeApp(makeDeps({ pool }));
        const res = await request(localApp)
            .post('/v1/public/apply')
            .field({ ...baseFields, cover_letter: 'private letter' });
        expect(res.status).toBe(201);
        const outboxPayloads = client.calls
            .filter((c) => c.sql.toLowerCase().includes('insert into outbox_events'))
            .map((c) => JSON.parse(String(c.params[1])));
        expect(outboxPayloads.length).toBeGreaterThan(0);
        for (const payload of outboxPayloads) {
            expect(JSON.stringify(payload)).not.toContain('private letter');
            expect(payload).not.toHaveProperty('cover_letter');
            expect(payload).not.toHaveProperty('coverLetter');
        }
    });
});

describe('cover_letter persistence (real Application model)', () => {
    function recordingClient(handlers: Array<[string, Record<string, unknown>[]]> = []) {
        const calls: Array<{ sql: string; params: unknown[] }> = [];
        const client: Queryable = {
            query: vi.fn(async (sql: string, params: unknown[] = []) => {
                calls.push({ sql, params });
                const lower = sql.toLowerCase();
                for (const [needle, rows] of handlers) {
                    if (lower.includes(needle.toLowerCase())) return { rows, rowCount: rows.length };
                }
                return { rows: [], rowCount: 0 };
            })
        } as unknown as Queryable;
        return { client, calls };
    }

    it('Application.create writes cover_letter into the INSERT', async () => {
        const { client, calls } = recordingClient([['returning *', [{ id: 42, status: 'pending' }]]]);
        await RealApplication.create(client, {
            candidate_id: 7,
            vacancy_id: 1,
            cover_letter: 'Dear hiring team'
        });
        const insert = calls.find((c) => c.sql.toLowerCase().includes('insert into applications'));
        expect(insert).toBeTruthy();
        expect(insert!.params).toContain('Dear hiring team');
    });

    it('detail reads select a.cover_letter', async () => {
        const { client, calls } = recordingClient([['from applications', []]]);
        await RealApplication.findDetailById(client, 42);
        expect(calls[0]!.sql.toLowerCase()).toContain('a.cover_letter');
    });
});

describe('cover_letter on HR-facing surfaces', () => {
    it('GET /v1/applications/:id includes cover_letter (HR only)', async () => {
        vi.mocked(Application.findDetailById).mockResolvedValueOnce({
            id: 42,
            vacancy_id: 1,
            status: 'pending',
            cover_letter: 'I love building UIs.',
            candidate: { id: 7, first_name: 'Ana' }
        });
        const res = await request(app).get('/v1/applications/42').set(HR_HEADERS);
        expect(res.status).toBe(200);
        expect(res.body.cover_letter).toBe('I love building UIs.');
    });

    it('GET /v1/vacancies/:id/applications includes cover_letter per row (HR only)', async () => {
        vi.mocked(Application.findDetailedByVacancy).mockResolvedValueOnce([
            { id: 42, status: 'pending', cover_letter: 'I love building UIs.', candidate: { id: 7 } }
        ]);
        const res = await request(app).get('/v1/vacancies/1/applications').set(HR_HEADERS);
        expect(res.status).toBe(200);
        expect(res.body[0].cover_letter).toBe('I love building UIs.');
    });
});
