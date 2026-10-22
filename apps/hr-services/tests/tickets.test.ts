// Service-desk ticket tests: SLA due-date computation, employee
// self-scoping, transition state machine (409s), and outbox events.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { EMP_A, EMP_B, EMPLOYEE_ID_A, HR, testApp, testConfig } from './helpers.js';
import { slaDueAt, slaHoursFor } from '../src/routes/tickets.js';

const TICKET_ROW = {
    id: 5,
    employee_id: EMPLOYEE_ID_A,
    category: 'general',
    subject: 'VPN access',
    description: 'Need VPN for remote work',
    status: 'new',
    priority: 'normal',
    assignee_user_id: null,
    sla_due_at: '2025-01-01T00:00:00Z',
    resolved_at: null,
    closed_at: null,
    created_by_user_id: 10,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
};

describe('SLA computation', () => {
    it('maps priorities to the configurable hour defaults (4h/24h/72h/7d)', () => {
        const config = testConfig();
        expect(slaHoursFor('critical', config)).toBe(4);
        expect(slaHoursFor('high', config)).toBe(24);
        expect(slaHoursFor('normal', config)).toBe(72);
        expect(slaHoursFor('low', config)).toBe(168);
    });

    it('slaDueAt adds the per-priority hours to the base time', () => {
        const config = testConfig();
        const base = new Date('2025-06-01T12:00:00Z');
        expect(slaDueAt('critical', config, base).toISOString()).toBe('2025-06-01T16:00:00.000Z');
        expect(slaDueAt('normal', config, base).toISOString()).toBe('2025-06-04T12:00:00.000Z');
        expect(slaDueAt('low', config, base).toISOString()).toBe('2025-06-08T12:00:00.000Z');
    });

    it('POST /v1/tickets/my persists a server-computed sla_due_at', async () => {
        const { app, stub } = testApp((text) => {
            if (text.includes('INSERT INTO tickets')) return { rows: [TICKET_ROW] };
            return { rows: [] };
        });
        const before = Date.now();
        const res = await request(app).post('/v1/tickets/my').set(EMP_A).send({
            subject: 'Laptop fan noise',
            description: 'Fan is rattling',
            priority: 'high'
        });
        expect(res.status).toBe(201);
        const insert = stub.calls.find((c) => c.text.includes('INSERT INTO tickets'))!;
        const dueParam = new Date(insert.params[5] as Date).getTime();
        // high → +24h (within a second of slack for test execution).
        expect(dueParam).toBeGreaterThanOrEqual(before + 24 * 3600_000);
        expect(dueParam).toBeLessThan(Date.now() + 24 * 3600_000 + 5_000);
        expect(insert.params[0]).toBe(EMPLOYEE_ID_A);
    });

    it('publishes strafor.services.ticket_created through the outbox', async () => {
        const { app, publisher } = testApp((text) => {
            if (text.includes('INSERT INTO tickets')) return { rows: [TICKET_ROW] };
            return { rows: [] };
        });
        await request(app).post('/v1/tickets/my').set(EMP_A).send({ subject: 's', description: 'd' });
        expect(publisher.published).toEqual([
            {
                type: 'strafor.services.ticket_created',
                payload: expect.objectContaining({ ticketId: 5, employeeId: EMPLOYEE_ID_A, status: 'new' })
            }
        ]);
    });
});

describe('employee self-scope', () => {
    it('GET /v1/tickets/my is scoped to the caller employee_id', async () => {
        const { app, stub } = testApp(() => ({ rows: [] }));
        const res = await request(app).get('/v1/tickets/my').set(EMP_A);
        expect(res.status).toBe(200);
        const q = stub.calls.find((c) => c.text.includes('FROM tickets'))!;
        expect(q.text).toContain('t.employee_id = $1');
        expect(q.params).toEqual([EMPLOYEE_ID_A]);
    });

    it('user A cannot read user B ticket — employee_id filter yields 404', async () => {
        const { app, stub } = testApp(() => ({ rows: [] }));
        // Ticket 5 belongs to employee 200 (user B). The scoped query returns
        // no row for employee 100, so the API answers 404 — not the data.
        const res = await request(app).get('/v1/tickets/my/5').set(EMP_A);
        expect(res.status).toBe(404);
        const q = stub.calls.find((c) => c.text.includes('FROM tickets'))!;
        expect(q.text).toContain('t.employee_id = $2');
        expect(q.params).toEqual([5, EMPLOYEE_ID_A]);
    });

    it('comments carry the owner predicate too', async () => {
        const { app, stub } = testApp(() => ({ rows: [] }));
        const res = await request(app).post('/v1/tickets/my/5/comments').set(EMP_A).send({ body: 'update?' });
        expect(res.status).toBe(404); // no ticket row matched employee 100
        const insert = stub.calls.find((c) => c.text.includes('INSERT INTO ticket_comments'))!;
        expect(insert.text).toContain('t.employee_id = $4');
        expect(insert.params[3]).toBe(EMPLOYEE_ID_A);
    });

    it('user B sees a different scope (employee 200)', async () => {
        const { app, stub } = testApp(() => ({ rows: [] }));
        await request(app).get('/v1/tickets/my').set(EMP_B);
        const q = stub.calls.find((c) => c.text.includes('FROM tickets'))!;
        expect(q.params).toEqual([200]);
    });
});

describe('HR workflow', () => {
    it('assign sets assignee + transitions new→assigned and publishes the event', async () => {
        const { app, publisher, stub } = testApp((text) => {
            if (text.includes('SELECT * FROM tickets')) return { rows: [TICKET_ROW] };
            if (text.includes('UPDATE tickets'))
                return { rows: [{ ...TICKET_ROW, status: 'assigned', assignee_user_id: 2 }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/tickets/5/assign').set(HR).send({ assigneeUserId: 2 });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('assigned');
        const hist = stub.calls.find((c) => c.text.includes('INSERT INTO ticket_status_history'))!;
        expect(hist.params).toContain('new');
        expect(hist.params).toContain('assigned');
        expect(publisher.published.map((e) => e.type)).toContain('strafor.services.ticket_assigned');
    });

    it('invalid transitions get 409 (closed is terminal)', async () => {
        const { app } = testApp((text) => {
            if (text.includes('SELECT * FROM tickets')) return { rows: [{ ...TICKET_ROW, status: 'closed' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/tickets/5/transition').set(HR).send({ status: 'in_progress' });
        expect(res.status).toBe(409);
    });

    it('resolve publishes strafor.services.ticket_resolved', async () => {
        const { app, publisher } = testApp((text) => {
            if (text.includes('SELECT * FROM tickets')) return { rows: [{ ...TICKET_ROW, status: 'in_progress' }] };
            if (text.includes('UPDATE tickets')) return { rows: [{ ...TICKET_ROW, status: 'resolved' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/tickets/5/transition').set(HR).send({ status: 'resolved' });
        expect(res.status).toBe(200);
        expect(publisher.published.map((e) => e.type)).toContain('strafor.services.ticket_resolved');
    });

    it('assign on a resolved ticket is a 409', async () => {
        const { app } = testApp((text) => {
            if (text.includes('SELECT * FROM tickets')) return { rows: [{ ...TICKET_ROW, status: 'resolved' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/tickets/5/assign').set(HR).send({ assigneeUserId: 2 });
        expect(res.status).toBe(409);
    });
});
