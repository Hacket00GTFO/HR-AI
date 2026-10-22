// RBAC tests — strict HR-only semantics ported from the monolith:
//   - no gateway identity headers → 401
//   - role 'admin' → 403 (admins must NOT receive candidate/recruitment data)
//   - role 'hr' → allowed
//   - valid X-Service-Token → allowed (internal service callers)
// plus the status-transition history write asserted at the model level.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request, { type Test } from 'supertest';
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

vi.mock('../src/models/application.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/models/application.js')>();
    return {
        ...orig,
        findWithVacancyTitle: vi.fn(),
        findForVacancy: vi.fn(),
        findDetailedByVacancy: vi.fn(),
        resolveForCandidate: vi.fn(),
        history: vi.fn(),
        updateStatus: vi.fn(),
        updateById: vi.fn(),
        legacyRow: vi.fn()
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
import * as Application from '../src/models/application.js';
import { makeApp, makeDeps, makeFakeDb, HR_HEADERS, ADMIN_HEADERS, SVC_HEADERS } from './helpers.js';

let app: Express;

beforeAll(() => {
    const { pool } = makeFakeDb();
    app = makeApp(makeDeps({ pool }));
});

beforeEach(() => {
    vi.mocked(Vacancy.findById).mockReset().mockResolvedValue({ id: 1, title: 'Frontend Engineer' });
    vi.mocked(Application.findWithVacancyTitle).mockReset().mockResolvedValue([]);
    vi.mocked(Application.resolveForCandidate)
        .mockReset()
        .mockResolvedValue({ id: 42, candidate_id: 7, vacancy_id: 1, status: 'pending' });
    vi.mocked(Application.updateStatus)
        .mockReset()
        .mockResolvedValue({ id: 7, status: 'interview', application_id: 42 });
    vi.mocked(Application.history).mockReset().mockResolvedValue([]);
});

describe('gateway-header auth (strict HR)', () => {
    const PROTECTED: Array<[string, string]> = [
        ['get', '/v1/vacancies/1'],
        ['put', '/v1/vacancies/1'],
        ['delete', '/v1/vacancies/1'],
        ['get', '/v1/vacancies/1/top-candidates'],
        ['get', '/v1/vacancies/1/candidates'],
        ['get', '/v1/vacancies/1/applications'],
        ['post', '/v1/vacancies'],
        ['get', '/v1/candidates'],
        ['get', '/v1/candidates/1/resume'],
        ['get', '/v1/candidates/1/history'],
        ['post', '/v1/candidates'],
        ['put', '/v1/candidates/1/status'],
        ['put', '/v1/candidates/1/feedback'],
        ['post', '/v1/ai/process-feedback']
    ];

    it.each(PROTECTED)('%s %s → 401 without identity headers', async (method, url) => {
        const res = await (request(app) as never as Record<string, (u: string) => Test>)[method]!(url).send({});
        expect(res.status).toBe(401);
    });

    it.each(PROTECTED)('%s %s → 403 for role admin (no candidate data)', async (method, url) => {
        const res = await (request(app) as never as Record<string, (u: string) => Test>)[method]!(url)
            .set(ADMIN_HEADERS)
            .send({});
        expect(res.status).toBe(403);
    });

    it('GET /v1/candidates → 200 for hr', async () => {
        const res = await request(app).get('/v1/candidates').set(HR_HEADERS);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('GET /v1/candidates → 200 for a trusted service caller', async () => {
        const res = await request(app).get('/v1/candidates').set(SVC_HEADERS);
        expect(res.status).toBe(200);
    });

    it('GET /v1/candidates → 401 for a wrong service token', async () => {
        const res = await request(app).get('/v1/candidates').set('X-Service-Token', 'wrong-token');
        expect(res.status).toBe(401);
    });

    it('GET /v1/vacancies is anonymous (public careers listing)', async () => {
        vi.mocked(Vacancy.find).mockResolvedValueOnce([]);
        const res = await request(app).get('/v1/vacancies');
        expect(res.status).toBe(200);
    });
});

describe('PUT /v1/candidates/:id/status', () => {
    it('transitions status, writes history and enqueues both event families', async () => {
        const { pool, client } = makeFakeDb();
        const localApp = makeApp(makeDeps({ pool }));
        const res = await request(localApp)
            .put('/v1/candidates/7/status')
            .set(HR_HEADERS)
            .send({ status: 'Interview' });
        expect(res.status).toBe(200);
        // updateStatus ran inside the route's tx (client arg present)
        const [, applicationId, toStatus, opts] = vi.mocked(Application.updateStatus).mock.calls.at(-1)!;
        expect(applicationId).toBe(42);
        expect(toStatus).toBe('interview');
        expect(opts).toMatchObject({ changedBy: 5 });
        const outboxTypes = client.calls
            .filter((c) => c.sql.toLowerCase().includes('insert into outbox_events'))
            .map((c) => c.params[0]);
        expect(outboxTypes).toEqual(
            expect.arrayContaining(['strafor.recruitment.candidate_status_changed', 'strafor.candidate.status_changed'])
        );
    });

    it('404 when the application does not exist', async () => {
        vi.mocked(Application.resolveForCandidate).mockResolvedValueOnce(null);
        const res = await request(app).put('/v1/candidates/7/status').set(HR_HEADERS).send({ status: 'interview' });
        expect(res.status).toBe(404);
    });
});
