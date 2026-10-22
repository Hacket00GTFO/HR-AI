// Authorisation matrix — admin is 403 on EVERY business route (HR and
// employee self-service alike), anonymous callers get 401, plain employees
// get 403 on HR routes, and /v1/internal accepts only X-Service-Token.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { ADMIN, EMP_A, HR, SERVICE, testApp } from './helpers.js';

// Every business route, every method. Bodies are irrelevant — the request
// must be rejected before any SQL runs.
const ROUTES: Array<[string, string]> = [
    // tickets — employee self-service
    ['post', '/v1/tickets/my'],
    ['get', '/v1/tickets/my'],
    ['get', '/v1/tickets/my/1'],
    ['post', '/v1/tickets/my/1/comments'],
    // tickets — HR
    ['post', '/v1/tickets'],
    ['get', '/v1/tickets'],
    ['get', '/v1/tickets/1'],
    ['post', '/v1/tickets/1/assign'],
    ['post', '/v1/tickets/1/transition'],
    ['post', '/v1/tickets/1/comments'],
    // assets — employee self-service
    ['get', '/v1/assets/my'],
    // assets — HR
    ['get', '/v1/assets'],
    ['post', '/v1/assets'],
    ['get', '/v1/assets/1'],
    ['put', '/v1/assets/1'],
    ['get', '/v1/assets/1/assignments'],
    ['post', '/v1/assets/1/checkout'],
    ['post', '/v1/assets/1/checkin'],
    // expenses — employee self-service
    ['post', '/v1/expenses/my'],
    ['get', '/v1/expenses/my'],
    ['get', '/v1/expenses/my/1'],
    ['put', '/v1/expenses/my/1'],
    ['post', '/v1/expenses/my/1/submit'],
    // expenses — HR
    ['get', '/v1/expenses'],
    ['get', '/v1/expenses/1'],
    ['post', '/v1/expenses/1/decide'],
    ['post', '/v1/expenses/1/pay'],
    // surveys — employee self-service
    ['get', '/v1/surveys/open'],
    ['get', '/v1/surveys/1/my-response'],
    ['post', '/v1/surveys/1/respond'],
    // surveys — HR
    ['post', '/v1/surveys'],
    ['get', '/v1/surveys'],
    ['get', '/v1/surveys/1'],
    ['post', '/v1/surveys/1/open'],
    ['post', '/v1/surveys/1/close'],
    ['get', '/v1/surveys/1/results']
];

describe('admin → 403 on every business route', () => {
    for (const [method, path] of ROUTES) {
        it(`${method.toUpperCase()} ${path}`, async () => {
            const { app, stub } = testApp();
            const res = await request(app)[method as 'get'](path).set(ADMIN).send({});
            expect(res.status).toBe(403);
            expect(stub.calls).toHaveLength(0); // rejected before any SQL
        });
    }
});

describe('authentication & role gating', () => {
    it('anonymous callers get 401 on business routes', async () => {
        const { app } = testApp();
        for (const path of ['/v1/tickets', '/v1/tickets/my', '/v1/expenses', '/v1/surveys', '/v1/assets']) {
            const res = await request(app).get(path);
            expect(res.status).toBe(401);
        }
    });

    it('employee role gets 403 on HR-only routes', async () => {
        const { app, stub } = testApp();
        for (const path of ['/v1/tickets', '/v1/expenses', '/v1/surveys', '/v1/assets']) {
            const res = await request(app).get(path).set(EMP_A);
            expect(res.status).toBe(403);
        }
        expect(stub.calls).toHaveLength(0);
    });

    it('a service token without user identity cannot use self-service routes', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/tickets/my').set(SERVICE);
        expect(res.status).toBe(401);
    });

    it('user identity headers cannot reach /v1/internal', async () => {
        const { app } = testApp();
        const res = await request(app).post('/v1/internal/employee-directory').set(HR).send({ employees: [] });
        expect(res.status).toBe(401);
    });

    it('service token is accepted on HR routes (trusted internal caller)', async () => {
        const { app } = testApp(() => ({ rows: [] }));
        const res = await request(app).get('/v1/tickets').set(SERVICE);
        expect(res.status).toBe(200);
    });

    it('a user with no linked employee record gets 403 on self-service', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/tickets/my').set({ 'X-User-Id': '99', 'X-User-Role': 'employee' });
        expect(res.status).toBe(403);
    });

    it('internal upsert works with the service token', async () => {
        const { app, stub } = testApp();
        const res = await request(app)
            .post('/v1/internal/employee-directory')
            .set(SERVICE)
            .send({ employees: [{ id: 100, userId: 10, department: 'Engineering' }] });
        expect(res.status).toBe(200);
        expect(res.body.upserted).toBe(1);
        expect(stub.calls[0]!.text).toContain('INSERT INTO employee_directory');
    });
});
