// Coverage for the endpoints added for the Next.js internal screens:
//   GET  /api/vacancies/:id          (HR only)
//   PUT  /api/vacancies/:id          (HR only, partial update)
//   GET  /api/candidates/:id/history (HR only)
//   GET  /api/candidates?status=&vacancy_id=&q=
// Runs WITHOUT a live database — see security.auth.test.js for the harness.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-vitest';

let app;

// Generous hook timeout — a cold import of server.js constructs the pg Pool
// and can exceed the 10s default when test files run in parallel.
beforeAll(async () => {
    const server = await import('../server.js');
    app = server.app;
    server.setDbConnected(true); // bypass the 503 DB guard
}, 30000);

const NEW_PROTECTED = [
    ['get', '/api/vacancies/1'],
    ['put', '/api/vacancies/1'],
    ['get', '/api/candidates/1/history']
];

describe('new endpoints require auth', () => {
    it.each(NEW_PROTECTED)('%s %s → 401 without a token', async (method, url) => {
        const res = await request(app)[method](url).send({});
        expect(res.status).toBe(401);
    });

    it.each(NEW_PROTECTED)('%s %s → 401 with a malformed token', async (method, url) => {
        const res = await request(app)[method](url).set('Authorization', 'Bearer not.a.real.token').send({});
        expect(res.status).toBe(401);
    });
});

describe('vacancyUpdateBody schema', () => {
    let schemas;
    beforeAll(async () => {
        schemas = await import('../middleware/schemas.js');
    });

    const partial = { title: 'Senior Backend Engineer', status: 'Paused' };

    it('accepts a partial update (title + status only)', () => {
        const r = schemas.vacancyUpdateBody.safeParse(partial);
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.title).toBe('Senior Backend Engineer');
            expect(r.data.status).toBe('Paused');
        }
    });

    it('rejects an empty body and a body of only unknown keys', () => {
        expect(schemas.vacancyUpdateBody.safeParse({}).success).toBe(false);
        expect(schemas.vacancyUpdateBody.safeParse({ hacker: 'stuff' }).success).toBe(false);
    });

    it('rejects an invalid lifecycle status', () => {
        expect(schemas.vacancyUpdateBody.safeParse({ status: 'exploding' }).success).toBe(false);
        expect(schemas.vacancyUpdateBody.safeParse({ status: 'Active' }).success).toBe(true);
    });

    it('trims skills and requires a non-empty skills_required when provided', () => {
        const ok = schemas.vacancyUpdateBody.safeParse({ skills_required: [' react ', '', 'node'] });
        expect(ok.success).toBe(true);
        if (ok.success) expect(ok.data.skills_required).toEqual(['react', 'node']);
        expect(schemas.vacancyUpdateBody.safeParse({ skills_required: [] }).success).toBe(false);
        expect(schemas.vacancyUpdateBody.safeParse({ skills_required: ['  '] }).success).toBe(false);
    });

    it('accepts salary_range + remote_option partials', () => {
        const r = schemas.vacancyUpdateBody.safeParse({
            salary_range: { min: '100', max: '200', currency: 'MXN' },
            remote_option: true
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.salary_range.min).toBe(100);
    });
});

describe('candidateListQuery schema', () => {
    let schemas;
    beforeAll(async () => {
        schemas = await import('../middleware/schemas.js');
    });

    it('coerces vacancy_id, lowercases status, passes q through', () => {
        const r = schemas.candidateListQuery.safeParse({ status: 'Interview', vacancy_id: '7', q: 'react' });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.status).toBe('interview');
            expect(r.data.vacancy_id).toBe(7);
            expect(r.data.q).toBe('react');
        }
    });

    it('rejects a non-canonical status and a non-numeric vacancy_id', () => {
        expect(schemas.candidateListQuery.safeParse({ status: 'hired!' }).success).toBe(false);
        expect(schemas.candidateListQuery.safeParse({ vacancy_id: 'abc' }).success).toBe(false);
    });
});
