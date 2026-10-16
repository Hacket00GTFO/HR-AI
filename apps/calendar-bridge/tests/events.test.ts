// Event lifecycle — persistence (subject hashed, never stored), idempotent
// external_ref, lookup by interviewId, cancellation, outbox events.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { SERVICE, testApp } from './helpers.js';

const EVENT = {
    organizerEmail: 'recruiter@corp.example',
    attendees: ['candidate@example.com', 'panel@corp.example'],
    subject: 'Interview: Jane Doe — Backend Engineer',
    start: '2030-03-11T15:00:00Z',
    end: '2030-03-11T16:00:00Z'
};

describe('POST /v1/calendar/events', () => {
    it('creates a stub event with a Teams link and persists the row', async () => {
        const { app, stub, publisher } = testApp();
        const res = await request(app)
            .post('/v1/calendar/events')
            .set(SERVICE)
            .send({ ...EVENT, locationOrTeams: true, externalRef: 'interview:42' });
        expect(res.status).toBe(201);
        const ev = res.body.event;
        expect(ev.provider).toBe('stub');
        expect(ev.providerEventId).toMatch(/^stub-\d+$/);
        expect(ev.joinUrl).toContain('teams.stub.local');
        expect(ev.status).toBe('scheduled');
        expect(ev.externalRef).toBe('interview:42');
        // The subject is NEVER echoed back or persisted.
        expect(ev.subject).toBeUndefined();

        const row = stub.events[0]!;
        expect(row.subject_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.organizer_email).toBe(EVENT.organizerEmail);
        expect(row.attendee_count).toBe(2);
        // No INSERT parameter carries the subject text.
        const insert = stub.calls.find((c) => c.text.includes('INSERT INTO calendar_events'))!;
        expect(insert.params).not.toContain(EVENT.subject);

        // Outbox → published domain event.
        expect(publisher.published).toEqual([
            expect.objectContaining({
                type: 'strafor.integrations.calendar_event_created',
                payload: expect.objectContaining({
                    eventId: ev.id,
                    provider: 'stub',
                    providerEventId: ev.providerEventId,
                    externalRef: 'interview:42',
                    attendeeCount: 2
                })
            })
        ]);
        expect(stub.audit).toContainEqual({ actor: 'service', action: 'event_create', external_ref: 'interview:42' });
    });

    it('no Teams link when locationOrTeams is false', async () => {
        const { app } = testApp();
        const res = await request(app)
            .post('/v1/calendar/events')
            .set(SERVICE)
            .send({ ...EVENT, locationOrTeams: false });
        expect(res.status).toBe(201);
        expect(res.body.event.joinUrl).toBeNull();
        expect(res.body.event.online).toBe(false);
    });

    it('is idempotent on externalRef — repeat creates return the same event', async () => {
        const { app, stub } = testApp();
        const body = { ...EVENT, locationOrTeams: true, externalRef: 'interview:42' };
        const first = await request(app).post('/v1/calendar/events').set(SERVICE).send(body);
        const second = await request(app).post('/v1/calendar/events').set(SERVICE).send(body);
        expect(first.status).toBe(201);
        expect(second.status).toBe(200);
        expect(second.body.idempotent).toBe(true);
        expect(second.body.event.id).toBe(first.body.event.id);
        expect(stub.events).toHaveLength(1); // single INSERT
    });

    it('accepts interviewId as the external ref shorthand', async () => {
        const { app, stub } = testApp();
        const res = await request(app)
            .post('/v1/calendar/events')
            .set(SERVICE)
            .send({ ...EVENT, locationOrTeams: true, interviewId: 7 });
        expect(res.status).toBe(201);
        expect(stub.events[0]!.external_ref).toBe('interview:7');
    });

    it('rejects invalid payloads', async () => {
        const { app } = testApp();
        const cases = [
            { ...EVENT, locationOrTeams: true, organizerEmail: 'nope' },
            { ...EVENT, locationOrTeams: true, subject: '' },
            { ...EVENT, locationOrTeams: true, start: EVENT.end, end: EVENT.start },
            { ...EVENT, locationOrTeams: true, unknownField: 1 }
        ];
        for (const body of cases) {
            const res = await request(app).post('/v1/calendar/events').set(SERVICE).send(body);
            expect(res.status).toBe(400);
        }
    });
});

describe('GET /v1/calendar/events', () => {
    it('looks up events by interviewId', async () => {
        const { app } = testApp();
        await request(app)
            .post('/v1/calendar/events')
            .set(SERVICE)
            .send({ ...EVENT, locationOrTeams: true, externalRef: 'interview:42' });
        const res = await request(app).get('/v1/calendar/events?interviewId=42').set(SERVICE);
        expect(res.status).toBe(200);
        expect(res.body.events).toHaveLength(1);
        expect(res.body.events[0].externalRef).toBe('interview:42');
    });

    it('returns an empty list for unknown refs and 400 without a ref', async () => {
        const { app } = testApp();
        const missing = await request(app).get('/v1/calendar/events?interviewId=999').set(SERVICE);
        expect(missing.status).toBe(200);
        expect(missing.body.events).toEqual([]);
        const bad = await request(app).get('/v1/calendar/events').set(SERVICE);
        expect(bad.status).toBe(400);
    });
});

describe('DELETE /v1/calendar/events/:id', () => {
    async function seed() {
        const t = testApp();
        const res = await request(t.app)
            .post('/v1/calendar/events')
            .set(SERVICE)
            .send({ ...EVENT, locationOrTeams: true, externalRef: 'interview:42' });
        return { ...t, eventId: res.body.event.id, providerEventId: res.body.event.providerEventId };
    }

    it('cancels by internal id and by provider event id', async () => {
        const { app, stub, publisher, providerEventId } = await seed();
        const byInternal = await request(app).delete(`/v1/calendar/events/1`).set(SERVICE);
        expect(byInternal.status).toBe(200);
        expect(byInternal.body.event.status).toBe('cancelled');
        expect(stub.events[0]!.status).toBe('cancelled');
        expect(publisher.published.map((p) => p.type)).toContain('strafor.integrations.calendar_event_cancelled');
        expect(stub.audit).toContainEqual({ actor: 'service', action: 'event_cancel', external_ref: 'interview:42' });

        // Second cancel is idempotent.
        const again = await request(app).delete(`/v1/calendar/events/${providerEventId}`).set(SERVICE);
        expect(again.status).toBe(200);
        expect(again.body.idempotent).toBe(true);
    });

    it('404s on unknown events', async () => {
        const { app } = testApp();
        const res = await request(app).delete('/v1/calendar/events/stub-999').set(SERVICE);
        expect(res.status).toBe(404);
    });
});

describe('GET /v1/calendar/provider', () => {
    it('reports stub mode with no M365 credentials configured', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/calendar/provider').set(SERVICE);
        expect(res.status).toBe(200);
        expect(res.body.provider).toBe('stub');
        expect(res.body.m365).toEqual({ tenantId: null, clientId: null, clientSecret: null });
    });

    it('reports the provider mode on /ready', async () => {
        const { app } = testApp();
        const res = await request(app).get('/ready');
        expect(res.status).toBe(200);
        expect(res.body.checks.provider).toBe('stub');
        expect(res.body.checks.db).toBe('ok');
    });
});
