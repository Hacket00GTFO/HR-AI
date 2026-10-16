// Security tests: every protected endpoint must reject unauthenticated and
// malformed-token requests. Runs WITHOUT a live database — a dummy
// DATABASE_URL is set so the pool can be constructed (never connected), and
// the app's db-connected guard is bypassed via the exported test hook.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-vitest';

let app;

beforeAll(async () => {
    const server = await import('../server.js');
    app = server.app;
    server.setDbConnected(true); // bypass the 503 DB guard for auth tests
});

// Every route that must require a valid token.
const PROTECTED = [
    ['get', '/api/candidates'],
    ['post', '/api/candidates'],
    ['post', '/api/candidates/upload'],
    ['put', '/api/candidates/1/status'],
    ['put', '/api/candidates/1/feedback'],
    ['get', '/api/candidates/1/resume'],
    ['post', '/api/vacancies'],
    ['delete', '/api/vacancies/1'],
    ['get', '/api/vacancies/1/candidates'],
    ['get', '/api/vacancies/1/top-candidates'],
    ['post', '/api/ai/process-feedback'],
    ['get', '/api/dashboard/activity'],
    ['get', '/api/dashboard/application-trends'],
    ['get', '/api/dashboard/department-stats'],
    ['get', '/api/dashboard/generate-report'],
    ['get', '/api/user/profile'],
    ['put', '/api/user/profile'],
    ['get', '/api/settings'],
    ['get', '/api/hr-accounts'],
    ['get', '/api/admin-accounts'],
    ['post', '/api/auth/register'],
    ['post', '/api/auth/logout'],
];

describe('authentication required', () => {
    it.each(PROTECTED)('%s %s → 401 without a token', async (method, url) => {
        const res = await request(app)[method](url).send({});
        expect(res.status).toBe(401);
    });

    it.each(PROTECTED)('%s %s → 401 with a malformed token', async (method, url) => {
        const res = await request(app)[method](url)
            .set('Authorization', 'Bearer not.a.real.token')
            .send({});
        expect(res.status).toBe(401);
    });

    it.each(PROTECTED)('%s %s → 401 with a token signed by the wrong secret', async (method, url) => {
        const jwt = (await import('jsonwebtoken')).default;
        const bad = jwt.sign({ id: 1, email: 'a@b.co', role: 'admin' }, 'wrong-secret');
        const res = await request(app)[method](url)
            .set('Authorization', `Bearer ${bad}`)
            .send({});
        expect(res.status).toBe(401);
    });
});

describe('public endpoints stay public', () => {
    it('GET /api/health responds (200 or 503, never 401)', async () => {
        const res = await request(app).get('/api/health');
        expect([200, 503]).toContain(res.status);
        expect(res.body).toHaveProperty('db');
    });

    it('GET /api/countries is reachable without a token (not 401)', async () => {
        const res = await request(app).get('/api/countries');
        expect(res.status).not.toBe(401);
    });

    it('GET /api/vacancies is reachable without a token (not 401)', async () => {
        // DB is stubbed-connected; without a real DB this may 500, but never 401.
        const res = await request(app).get('/api/vacancies');
        expect(res.status).not.toBe(401);
    });

    it('POST /api/auth/login is reachable without a token (not 401 for missing auth header)', async () => {
        const res = await request(app).post('/api/auth/login').send({});
        expect(res.status).not.toBe(401);
    });

    it('GET /api/auth/test debug route was removed', async () => {
        const res = await request(app).get('/api/auth/test');
        expect(res.status).toBe(404);
    });
});
