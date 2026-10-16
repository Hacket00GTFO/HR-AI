// Authorisation matrix — admin is 403 on EVERY business route, anonymous
// callers get 401, plain employees get 403, HR users and the service token
// are accepted.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { ADMIN, EMPLOYEE, HR, SERVICE, testApp } from './helpers.js';

// Every business route, every method. Bodies are irrelevant — the request
// must be rejected before any SQL runs.
const ROUTES: Array<[string, string]> = [
    ['get', '/v1/calendar/provider'],
    ['post', '/v1/calendar/free-busy'],
    ['post', '/v1/calendar/events'],
    ['get', '/v1/calendar/events?interviewId=1'],
    ['delete', '/v1/calendar/events/1']
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
        const { app, stub } = testApp();
        for (const [method, path] of ROUTES) {
            const res = await request(app)[method as 'get'](path).send({});
            expect(res.status).toBe(401);
        }
        expect(stub.calls).toHaveLength(0);
    });

    it('employee role gets 403 on business routes', async () => {
        const { app, stub } = testApp();
        for (const [method, path] of ROUTES) {
            const res = await request(app)[method as 'get'](path).set(EMPLOYEE).send({});
            expect(res.status).toBe(403);
        }
        expect(stub.calls).toHaveLength(0);
    });

    it('a wrong service token gets 401', async () => {
        const { app } = testApp();
        const res = await request(app)
            .post('/v1/calendar/free-busy')
            .set({ 'X-Service-Token': 'wrong-token' })
            .send({ emails: ['a@b.co'], start: '2030-01-01T09:00:00Z', end: '2030-01-01T10:00:00Z' });
        expect(res.status).toBe(401);
    });

    it('service token is accepted on business routes', async () => {
        const { app } = testApp();
        const res = await request(app)
            .post('/v1/calendar/free-busy')
            .set(SERVICE)
            .send({ emails: ['a@b.co'], start: '2030-01-01T09:00:00Z', end: '2030-01-01T10:00:00Z' });
        expect(res.status).toBe(200);
    });

    it('HR user identity is accepted on business routes', async () => {
        const { app } = testApp();
        const res = await request(app)
            .post('/v1/calendar/free-busy')
            .set(HR)
            .send({ emails: ['a@b.co'], start: '2030-01-01T09:00:00Z', end: '2030-01-01T10:00:00Z' });
        expect(res.status).toBe(200);
    });
});
