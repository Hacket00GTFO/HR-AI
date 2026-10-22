import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { asUser, makeTestApp } from './helpers.js';

describe('attendance', () => {
    it('rejects geo without consent, stores it with consent (point-in-time)', async () => {
        const { app, state, published } = makeTestApp();
        const emp = asUser(5, 'employee');

        const noConsent = await request(app)
            .post('/v1/attendance/check')
            .set(emp)
            .send({ kind: 'check_in', lat: 19.4326, lng: -99.1332, accuracy: 15, consent: false });
        expect(noConsent.status).toBe(400);
        expect(noConsent.body.error).toMatch(/consent/i);

        const ok = await request(app)
            .post('/v1/attendance/check')
            .set(emp)
            .send({ kind: 'check_in', lat: 19.4326, lng: -99.1332, accuracy: 15, consent: true });
        expect(ok.status).toBe(201);
        expect(ok.body.kind).toBe('check_in');
        expect(ok.body.geo.lat).toBeCloseTo(19.4326);
        expect(ok.body.source).toBe('pwa');
        expect(state.attendanceEvents[0].geo_consent).toBe(true);
        expect(published.some((e) => e.type === 'strafor.attendance.recorded')).toBe(true);

        // no geo at all is fine too
        const out = await request(app).post('/v1/attendance/check').set(emp).send({ kind: 'check_out' });
        expect(out.status).toBe(201);
        expect(out.body.geo).toBeNull();
    });

    it('rejects a duplicate open check-in with 409 until check-out', async () => {
        const { app } = makeTestApp();
        const emp = asUser(7, 'employee');

        const first = await request(app).post('/v1/attendance/check').set(emp).send({ kind: 'check_in' });
        expect(first.status).toBe(201);

        const dup = await request(app).post('/v1/attendance/check').set(emp).send({ kind: 'check_in' });
        expect(dup.status).toBe(409);
        expect(dup.body.details.openEventId).toBe(first.body.id);

        const out = await request(app).post('/v1/attendance/check').set(emp).send({ kind: 'check_out' });
        expect(out.status).toBe(201);

        const again = await request(app).post('/v1/attendance/check').set(emp).send({ kind: 'check_in' });
        expect(again.status).toBe(201);
    });

    it('employee sees only own events; hr sees all; admin gets 403 everywhere', async () => {
        const { app } = makeTestApp();
        await request(app).post('/v1/attendance/check').set(asUser(5, 'employee')).send({ kind: 'check_in' });
        await request(app).post('/v1/attendance/check').set(asUser(9, 'employee')).send({ kind: 'check_in' });

        const mine = await request(app).get('/v1/attendance/mine').set(asUser(5, 'employee'));
        expect(mine.status).toBe(200);
        expect(mine.body.events).toHaveLength(1);
        expect(mine.body.events[0].employeeId).toBe(5);

        // employee cannot hit the HR feed
        const denied = await request(app).get('/v1/attendance').set(asUser(5, 'employee'));
        expect(denied.status).toBe(403);

        const all = await request(app).get('/v1/attendance').set(asUser(1, 'hr'));
        expect(all.status).toBe(200);
        expect(all.body.events).toHaveLength(2);

        const filtered = await request(app).get('/v1/attendance?employeeId=9').set(asUser(1, 'hr'));
        expect(filtered.body.events).toHaveLength(1);
        expect(filtered.body.events[0].employeeId).toBe(9);

        // governance: admin role never touches attendance/geo data
        const admin = await request(app).get('/v1/attendance/mine').set(asUser(1, 'admin'));
        expect(admin.status).toBe(403);
        const adminCheck = await request(app)
            .post('/v1/attendance/check')
            .set(asUser(1, 'admin'))
            .send({ kind: 'check_in' });
        expect(adminCheck.status).toBe(403);
        const adminFeed = await request(app).get('/v1/attendance').set(asUser(1, 'admin'));
        expect(adminFeed.status).toBe(403);

        // missing headers → 401
        const anon = await request(app).get('/v1/attendance/mine');
        expect(anon.status).toBe(401);
    });

    it('correction flow: request → hr approve applies to the event', async () => {
        const { app, state } = makeTestApp();
        const emp = asUser(5, 'employee');

        const punch = await request(app)
            .post('/v1/attendance/check')
            .set(emp)
            .send({ kind: 'check_in', occurredAt: '2025-01-10T15:00:00Z' });
        expect(punch.status).toBe(201);

        const corr = await request(app)
            .post('/v1/attendance/corrections')
            .set(emp)
            .send({
                eventId: punch.body.id,
                field: 'occurred_at',
                newValue: { occurredAt: '2025-01-10T14:00:00Z' },
                reason: 'Forgot to check in on time'
            });
        expect(corr.status).toBe(201);
        expect(corr.body.status).toBe('pending');
        expect(corr.body.oldValue.occurredAt).toBeTruthy();

        // another employee cannot correct it
        const forbidden = await request(app)
            .post('/v1/attendance/corrections')
            .set(asUser(9, 'employee'))
            .send({
                eventId: punch.body.id,
                field: 'kind',
                newValue: { kind: 'check_out' },
                reason: 'not mine'
            });
        expect(forbidden.status).toBe(403);

        // manager approves → applied in tx, source flips to 'correction'
        const approve = await request(app)
            .put(`/v1/attendance/corrections/${corr.body.id}/approve`)
            .set(asUser(2, 'manager'));
        expect(approve.status).toBe(200);
        expect(approve.body.status).toBe('approved');
        expect(approve.body.reviewedBy).toBe(2);

        const ev = state.attendanceEvents.find((e) => e.id === punch.body.id);
        expect(new Date(ev.occurred_at).toISOString()).toBe('2025-01-10T14:00:00.000Z');
        expect(ev.source).toBe('correction');

        // already decided → 409
        const again = await request(app).put(`/v1/attendance/corrections/${corr.body.id}/approve`).set(asUser(1, 'hr'));
        expect(again.status).toBe(409);
    });

    it('correction reject does not touch the event; employees cannot approve', async () => {
        const { app, state } = makeTestApp();
        const punch = await request(app)
            .post('/v1/attendance/check')
            .set(asUser(5, 'employee'))
            .send({ kind: 'check_in', occurredAt: '2025-02-01T15:00:00Z' });

        const corr = await request(app)
            .post('/v1/attendance/corrections')
            .set(asUser(5, 'employee'))
            .send({
                eventId: punch.body.id,
                field: 'kind',
                newValue: { kind: 'check_out' },
                reason: 'wrong kind'
            });
        expect(corr.status).toBe(201);

        // employees cannot approve corrections
        const selfApprove = await request(app)
            .put(`/v1/attendance/corrections/${corr.body.id}/approve`)
            .set(asUser(5, 'employee'));
        expect(selfApprove.status).toBe(403);

        const reject = await request(app).put(`/v1/attendance/corrections/${corr.body.id}/reject`).set(asUser(1, 'hr'));
        expect(reject.status).toBe(200);
        expect(reject.body.status).toBe('rejected');

        const ev = state.attendanceEvents.find((e) => e.id === punch.body.id);
        expect(ev.kind).toBe('check_in');
        expect(ev.source).toBe('pwa');
    });
});
