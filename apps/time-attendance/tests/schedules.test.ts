import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { asUser, makeTestApp } from './helpers.js';
import { mxVacationDays, yearsOfServiceAt } from '../src/mxVacation.js';

const HR = asUser(1, 'hr');

describe('schedules', () => {
    it('hr CRUD: create → list → get → update → soft delete', async () => {
        const { app } = makeTestApp();

        const created = await request(app)
            .post('/v1/schedules')
            .set(HR)
            .send({
                name: 'Oficina fija',
                type: 'fixed',
                weeklyHours: 40,
                config: { workdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '18:00' }
            });
        expect(created.status).toBe(201);
        const id = created.body.id;

        const list = await request(app).get('/v1/schedules').set(HR);
        expect(list.body.schedules).toHaveLength(1);

        const updated = await request(app)
            .put(`/v1/schedules/${id}`)
            .set(HR)
            .send({ weeklyHours: 48, type: 'flexible' });
        expect(updated.status).toBe(200);
        expect(updated.body.weeklyHours).toBe(48);
        expect(updated.body.type).toBe('flexible');

        const del = await request(app).delete(`/v1/schedules/${id}`).set(HR);
        expect(del.status).toBe(204);
        const after = await request(app).get('/v1/schedules?active=false').set(HR);
        expect(after.body.schedules[0].active).toBe(false);
    });

    it('assign/unassign — one open assignment per employee', async () => {
        const { app } = makeTestApp();
        const s1 = (
            await request(app).post('/v1/schedules').set(HR).send({ name: 'A', type: 'fixed', weeklyHours: 40 })
        ).body.id;
        const s2 = (
            await request(app).post('/v1/schedules').set(HR).send({ name: 'B', type: 'shift', weeklyHours: 42 })
        ).body.id;

        const assign = await request(app)
            .post(`/v1/schedules/${s1}/assign`)
            .set(HR)
            .send({ employeeId: 5, effectiveFrom: '2025-01-01' });
        expect(assign.status).toBe(201);

        // second open assignment for the same employee → 409
        const dup = await request(app)
            .post(`/v1/schedules/${s2}/assign`)
            .set(HR)
            .send({ employeeId: 5, effectiveFrom: '2025-02-01' });
        expect(dup.status).toBe(409);

        // bounded assignment is allowed
        const bounded = await request(app)
            .post(`/v1/schedules/${s2}/assign`)
            .set(HR)
            .send({ employeeId: 5, effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' });
        expect(bounded.status).toBe(201);

        const unassign = await request(app)
            .post(`/v1/schedules/${s1}/unassign`)
            .set(HR)
            .send({ employeeId: 5, effectiveTo: '2025-01-31' });
        expect(unassign.status).toBe(200);
        expect(unassign.body.effectiveTo).toBe('2025-01-31');

        const gone = await request(app).post(`/v1/schedules/${s1}/unassign`).set(HR).send({ employeeId: 5 });
        expect(gone.status).toBe(404);
    });

    it('non-hr callers are rejected (employee, admin → 403)', async () => {
        const { app } = makeTestApp();
        for (const role of ['employee', 'manager', 'admin']) {
            const res = await request(app)
                .post('/v1/schedules')
                .set(asUser(3, role))
                .send({ name: 'x', type: 'fixed', weeklyHours: 40 });
            expect(res.status).toBe(403);
        }
        const list = await request(app).get('/v1/schedules').set(asUser(3, 'employee'));
        expect(list.status).toBe(403);
        const anon = await request(app).get('/v1/schedules');
        expect(anon.status).toBe(401);
    });
});

describe('mxVacation (LFT art. 76)', () => {
    it('statutory table: 12 days year 1, +2/yr to 20, then +2 per 5 years', () => {
        expect(mxVacationDays(0)).toBe(0);
        expect(mxVacationDays(1)).toBe(12);
        expect(mxVacationDays(2)).toBe(14);
        expect(mxVacationDays(5)).toBe(20);
        expect(mxVacationDays(6)).toBe(22);
        expect(mxVacationDays(10)).toBe(22);
        expect(mxVacationDays(11)).toBe(24);
        expect(mxVacationDays(15)).toBe(24);
        expect(mxVacationDays(16)).toBe(26);
        expect(mxVacationDays(31)).toBe(32);
        // beyond the seeded table it keeps extending +2 per 5-year block
        expect(mxVacationDays(36)).toBe(34);
    });

    it('years of service counts only completed anniversaries', () => {
        const hire = new Date(Date.UTC(2020, 5, 15)); // 2020-06-15
        expect(yearsOfServiceAt(hire, new Date(Date.UTC(2025, 5, 14)))).toBe(4);
        expect(yearsOfServiceAt(hire, new Date(Date.UTC(2025, 5, 15)))).toBe(5);
        expect(yearsOfServiceAt(hire, new Date(Date.UTC(2020, 6, 1)))).toBe(0);
    });
});
