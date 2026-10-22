// Interviews — POST/GET /v1/vacancies/:id/interviews + GET/PUT
// /v1/interviews/:id. Route layer under test: models mocked, the pool is a
// recording fake (withTransaction runs for real so outbox inserts are
// observable).
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

vi.mock('../src/models/application.js', () => ({
    findById: vi.fn(),
    findDetailById: vi.fn(),
    findDetailedByVacancy: vi.fn(),
    findForVacancy: vi.fn(),
    findWithVacancyTitle: vi.fn(),
    resolveForCandidate: vi.fn(),
    history: vi.fn(),
    updateStatus: vi.fn(),
    updateById: vi.fn(),
    legacyRow: vi.fn(),
    create: vi.fn()
}));

vi.mock('../src/models/interview.js', () => ({
    create: vi.fn(),
    findById: vi.fn(),
    findByVacancy: vi.fn(),
    updateById: vi.fn()
}));

vi.mock('../src/serviceClient.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/serviceClient.js')>();
    return { ...orig, callService: vi.fn(), uploadDocument: vi.fn(), fetchDocumentDownload: vi.fn() };
});

import * as Vacancy from '../src/models/vacancy.js';
import * as Application from '../src/models/application.js';
import * as Interview from '../src/models/interview.js';
import { makeApp, makeDeps, makeFakeDb, HR_HEADERS, ADMIN_HEADERS } from './helpers.js';

const SCHEDULED = '2026-03-10T15:00:00.000Z';

const INTERVIEW_ROW = {
    id: 11,
    application_id: 5,
    candidate_id: 7,
    vacancy_id: 1,
    scheduled_at: new Date(SCHEDULED),
    duration_minutes: 45,
    interviewer_user_id: 9,
    location_or_link: 'https://meet.example/abc',
    status: 'scheduled',
    scorecard: null,
    notes: null
};

function newApp(handlers: Array<[string, Record<string, unknown>[]]> = []) {
    const db = makeFakeDb([
        ['from candidates', [{ first_name: 'Ana', last_name: 'Garcia', email: 'ana@example.com' }]],
        ['from users_projection', [{ name: 'Bob Interviewer' }]],
        ...handlers
    ]);
    return { app: makeApp(makeDeps({ pool: db.pool })), client: db.client };
}

let app: Express;
let client: ReturnType<typeof makeFakeDb>['client'];

beforeAll(() => {
    ({ app, client } = newApp());
});

beforeEach(() => {
    vi.mocked(Vacancy.findById).mockReset().mockResolvedValue({ id: 1, title: 'Frontend Engineer' });
    vi.mocked(Application.findById)
        .mockReset()
        .mockResolvedValue({ id: 5, candidate_id: 7, vacancy_id: 1, status: 'interview' });
    vi.mocked(Application.resolveForCandidate)
        .mockReset()
        .mockResolvedValue({ id: 5, candidate_id: 7, vacancy_id: 1, status: 'interview' });
    vi.mocked(Interview.create).mockReset().mockResolvedValue(INTERVIEW_ROW);
    vi.mocked(Interview.findById).mockReset().mockResolvedValue(INTERVIEW_ROW);
    vi.mocked(Interview.findByVacancy).mockReset().mockResolvedValue([INTERVIEW_ROW]);
    vi.mocked(Interview.updateById)
        .mockReset()
        .mockResolvedValue({ ...INTERVIEW_ROW, status: 'done' });
});

describe('POST /v1/vacancies/:id/interviews', () => {
    it('creates an interview by application_id → 201 + strafor.interview.scheduled', async () => {
        const res = await request(app).post('/v1/vacancies/1/interviews').set(HR_HEADERS).send({
            application_id: 5,
            scheduled_at: SCHEDULED,
            duration_minutes: 45,
            interviewer_user_id: 9,
            location_or_link: 'https://meet.example/abc'
        });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ id: 11, application_id: 5, status: 'scheduled' });
        expect(Interview.create).toHaveBeenCalledTimes(1);
        const [, data] = vi.mocked(Interview.create).mock.calls[0]!;
        expect(data).toMatchObject({
            application_id: 5,
            candidate_id: 7,
            vacancy_id: 1,
            duration_minutes: 45,
            interviewer_user_id: 9,
            created_by: 5
        });

        const outbox = client.calls
            .filter((c) => c.sql.toLowerCase().includes('insert into outbox_events'))
            .map((c) => ({ type: c.params[0], payload: JSON.parse(String(c.params[1])) }));
        const evt = outbox.filter((e) => e.type === 'strafor.interview.scheduled').at(-1);
        expect(evt).toBeTruthy();
        expect(evt!.payload).toMatchObject({
            interviewId: 11,
            applicationId: 5,
            candidateId: 7,
            vacancyId: 1,
            email: 'ana@example.com',
            name: 'Ana Garcia',
            vacancyTitle: 'Frontend Engineer',
            interviewerUserId: 9,
            interviewerName: 'Bob Interviewer',
            durationMinutes: 45,
            locationOrLink: 'https://meet.example/abc'
        });
        // No PII beyond the invite email on the bus.
        expect(evt!.payload).not.toHaveProperty('cover_letter');
        expect(evt!.payload).not.toHaveProperty('phone');
    });

    it('resolves candidate_id to the latest application on the vacancy', async () => {
        const res = await request(app)
            .post('/v1/vacancies/1/interviews')
            .set(HR_HEADERS)
            .send({ candidate_id: 7, scheduled_at: SCHEDULED });
        expect(res.status).toBe(201);
        expect(Application.resolveForCandidate).toHaveBeenCalledWith(expect.anything(), 7, 1);
        // default duration applies
        const [, data] = vi.mocked(Interview.create).mock.calls.at(-1)!;
        expect(data.duration_minutes).toBe(60);
    });

    it('accepts `duration` as an alias for duration_minutes', async () => {
        const res = await request(app)
            .post('/v1/vacancies/1/interviews')
            .set(HR_HEADERS)
            .send({ application_id: 5, scheduled_at: SCHEDULED, duration: 30 });
        expect(res.status).toBe(201);
        const [, data] = vi.mocked(Interview.create).mock.calls.at(-1)!;
        expect(data.duration_minutes).toBe(30);
    });

    it('400 when neither application_id nor candidate_id is given', async () => {
        const res = await request(app)
            .post('/v1/vacancies/1/interviews')
            .set(HR_HEADERS)
            .send({ scheduled_at: SCHEDULED });
        expect(res.status).toBe(400);
        expect(Interview.create).not.toHaveBeenCalled();
    });

    it('400 without scheduled_at', async () => {
        const res = await request(app).post('/v1/vacancies/1/interviews').set(HR_HEADERS).send({ application_id: 5 });
        expect(res.status).toBe(400);
    });

    it('400 when the application belongs to another vacancy', async () => {
        vi.mocked(Application.findById).mockResolvedValueOnce({ id: 5, candidate_id: 7, vacancy_id: 99 });
        const res = await request(app)
            .post('/v1/vacancies/1/interviews')
            .set(HR_HEADERS)
            .send({ application_id: 5, scheduled_at: SCHEDULED });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('does not belong');
        expect(Interview.create).not.toHaveBeenCalled();
    });

    it('404 when the vacancy does not exist', async () => {
        vi.mocked(Vacancy.findById).mockResolvedValueOnce(null);
        const res = await request(app)
            .post('/v1/vacancies/1/interviews')
            .set(HR_HEADERS)
            .send({ application_id: 5, scheduled_at: SCHEDULED });
        expect(res.status).toBe(404);
    });

    it('404 when the application does not exist', async () => {
        vi.mocked(Application.findById).mockResolvedValueOnce(null);
        const res = await request(app)
            .post('/v1/vacancies/1/interviews')
            .set(HR_HEADERS)
            .send({ application_id: 5, scheduled_at: SCHEDULED });
        expect(res.status).toBe(404);
    });
});

describe('GET /v1/vacancies/:id/interviews', () => {
    it('lists interviews for the vacancy', async () => {
        const res = await request(app).get('/v1/vacancies/1/interviews').set(HR_HEADERS);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([expect.objectContaining({ id: 11, status: 'scheduled' })]);
    });

    it('404 when the vacancy does not exist', async () => {
        vi.mocked(Vacancy.findById).mockResolvedValueOnce(null);
        const res = await request(app).get('/v1/vacancies/1/interviews').set(HR_HEADERS);
        expect(res.status).toBe(404);
    });
});

describe('GET /v1/interviews/:id', () => {
    it('returns the interview', async () => {
        const res = await request(app).get('/v1/interviews/11').set(HR_HEADERS);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(11);
    });

    it('404 when missing', async () => {
        vi.mocked(Interview.findById).mockResolvedValueOnce(null);
        const res = await request(app).get('/v1/interviews/11').set(HR_HEADERS);
        expect(res.status).toBe(404);
    });
});

describe('PUT /v1/interviews/:id', () => {
    it('records status done + a valid scorecard', async () => {
        const scorecard = {
            criteria: [
                { name: 'technical', rating: 5, notes: 'sharp' },
                { name: 'communication', rating: 4 }
            ],
            overall_rating: 5,
            notes: 'strong hire'
        };
        const res = await request(app).put('/v1/interviews/11').set(HR_HEADERS).send({ status: 'done', scorecard });
        expect(res.status).toBe(200);
        const [, , fields] = vi.mocked(Interview.updateById).mock.calls.at(-1)!;
        expect(fields.status).toBe('done');
        expect(fields.scorecard).toEqual(scorecard);
    });

    it('rejects a scorecard rating outside 1-5 → 400', async () => {
        const res = await request(app)
            .put('/v1/interviews/11')
            .set(HR_HEADERS)
            .send({ scorecard: { criteria: [{ name: 'technical', rating: 6 }] } });
        expect(res.status).toBe(400);
        expect(Interview.updateById).not.toHaveBeenCalled();
    });

    it('rejects an empty body and a bad status → 400', async () => {
        expect((await request(app).put('/v1/interviews/11').set(HR_HEADERS).send({})).status).toBe(400);
        expect((await request(app).put('/v1/interviews/11').set(HR_HEADERS).send({ status: 'maybe' })).status).toBe(
            400
        );
    });

    it('404 when the interview does not exist', async () => {
        vi.mocked(Interview.updateById).mockResolvedValueOnce(null);
        const res = await request(app).put('/v1/interviews/11').set(HR_HEADERS).send({ location_or_link: 'Room 4' });
        expect(res.status).toBe(404);
    });
});

describe('interview routes are HR-only', () => {
    const CASES: Array<[string, string]> = [
        ['post', '/v1/vacancies/1/interviews'],
        ['get', '/v1/vacancies/1/interviews'],
        ['get', '/v1/interviews/1'],
        ['put', '/v1/interviews/1']
    ];

    it.each(CASES)('%s %s → 401 without identity headers', async (method, url) => {
        const res = await (request(app) as never as Record<string, (u: string) => import('supertest').Test>)[method]!(
            url
        ).send({});
        expect(res.status).toBe(401);
    });

    it.each(CASES)('%s %s → 403 for admin', async (method, url) => {
        const res = await (request(app) as never as Record<string, (u: string) => import('supertest').Test>)[method]!(
            url
        )
            .set(ADMIN_HEADERS)
            .send({});
        expect(res.status).toBe(403);
    });
});
