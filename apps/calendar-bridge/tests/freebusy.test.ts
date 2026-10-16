// Free/busy endpoint — response shape, validation, and stub determinism.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { SERVICE, testApp } from './helpers.js';
import { stubBusyIntervals } from '../src/provider.js';

const WINDOW = { start: '2030-03-10T08:00:00Z', end: '2030-03-10T18:00:00Z' };

describe('POST /v1/calendar/free-busy', () => {
    it('returns per-email busy intervals in the documented shape', async () => {
        const { app } = testApp();
        const res = await request(app)
            .post('/v1/calendar/free-busy')
            .set(SERVICE)
            .send({ emails: ['ada@corp.example', 'grace@corp.example'], ...WINDOW });
        expect(res.status).toBe(200);
        expect(res.body.provider).toBe('stub');
        expect(res.body.results).toHaveLength(2);
        for (const r of res.body.results) {
            expect(typeof r.email).toBe('string');
            expect(Array.isArray(r.busy)).toBe(true);
            for (const b of r.busy) {
                expect(new Date(b.start).toISOString()).toBe(b.start);
                expect(b.end > b.start).toBe(true);
                // Every interval stays inside the query window.
                expect(b.start >= WINDOW.start).toBe(true);
                expect(b.end <= WINDOW.end).toBe(true);
            }
        }
    });

    it('is deterministic — identical requests return identical schedules', async () => {
        const { app } = testApp();
        const body = { emails: ['ada@corp.example'], ...WINDOW };
        const a = await request(app).post('/v1/calendar/free-busy').set(SERVICE).send(body);
        const b = await request(app).post('/v1/calendar/free-busy').set(SERVICE).send(body);
        expect(a.status).toBe(200);
        expect(b.body.results).toEqual(a.body.results);
    });

    it('writes a free_busy audit row', async () => {
        const { app, stub } = testApp();
        await request(app)
            .post('/v1/calendar/free-busy')
            .set(SERVICE)
            .send({ emails: ['ada@corp.example'], ...WINDOW });
        expect(stub.audit).toEqual([{ actor: 'service', action: 'free_busy', external_ref: null }]);
    });

    it('rejects invalid payloads', async () => {
        const { app } = testApp();
        const cases = [
            {}, // missing everything
            { emails: [], ...WINDOW }, // empty emails
            { emails: ['not-an-email'], ...WINDOW },
            { emails: ['a@b.co'], start: WINDOW.end, end: WINDOW.start }, // end <= start
            { emails: ['a@b.co'], start: 'nope', end: WINDOW.end }
        ];
        for (const body of cases) {
            const res = await request(app).post('/v1/calendar/free-busy').set(SERVICE).send(body);
            expect(res.status).toBe(400);
        }
    });
});

describe('stubBusyIntervals (unit)', () => {
    const start = new Date('2030-03-10T08:00:00Z');
    const end = new Date('2030-03-10T18:00:00Z');

    it('is a pure function of (email, start, end)', () => {
        expect(stubBusyIntervals('x@y.z', start, end)).toEqual(stubBusyIntervals('x@y.z', start, end));
    });

    it('is case-insensitive on the email seed', () => {
        expect(stubBusyIntervals('X@y.z', start, end)).toEqual(stubBusyIntervals('x@y.z', start, end));
    });

    it('produces distinct schedules across a set of emails', () => {
        const schedules = new Set(
            ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io'].map((e) =>
                JSON.stringify(stubBusyIntervals(e, start, end))
            )
        );
        expect(schedules.size).toBeGreaterThan(1);
    });

    it('snaps blocks to the 15-minute grid and never exceeds the window', () => {
        for (const email of ['a@x.io', 'b@x.io', 'c@x.io']) {
            for (const b of stubBusyIntervals(email, start, end)) {
                expect(new Date(b.start).getTime() % (15 * 60_000)).toBe(0);
                expect(new Date(b.end).getTime() % (15 * 60_000)).toBe(0);
                expect(new Date(b.end).getTime()).toBeLessThanOrEqual(end.getTime());
            }
        }
    });
});
