import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { asUser, makeTestApp } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const SVC = { 'X-Service-Token': 'test-service-token' };

describe('leave', () => {
    it('serves the seeded MX statutory leave types', async () => {
        const { app } = makeTestApp();
        const res = await request(app).get('/v1/leave/types').set(asUser(5, 'employee'));
        expect(res.status).toBe(200);
        const codes = res.body.types.map((t: { code: string }) => t.code);
        expect(codes).toEqual(
            expect.arrayContaining(['vacaciones', 'incapacidad', 'permiso', 'maternidad', 'paternidad'])
        );
        const vac = res.body.types.find((t: { code: string }) => t.code === 'vacaciones');
        expect(vac.accrual.table[0]).toEqual({ minYears: 1, maxYears: 1, days: 12 });
    });

    it('approve decrements the balance in tx; insufficient balance → 409', async () => {
        const { app, state, published } = makeTestApp();
        const emp = asUser(5, 'employee');
        const hr = asUser(1, 'hr');

        // accrue first — hired 2 years ago → 14 days (LFT-76)
        const accrue = await request(app)
            .post('/v1/leave/accrue')
            .set(SVC)
            .send({ employeeId: 5, hireDate: `${YEAR - 2}-01-01`, asOf: `${YEAR}-06-01` });
        expect(accrue.status).toBe(200);
        expect(accrue.body.entitled).toBe(14);
        expect(accrue.body.yearsOfService).toBe(2);

        // request within balance → approve succeeds, used=8
        const reqRes = await request(app)
            .post('/v1/leave/requests')
            .set(emp)
            .send({
                leaveTypeCode: 'vacaciones',
                startDate: `${YEAR}-07-01`,
                endDate: `${YEAR}-07-08`, // 8 inclusive days
                reason: 'family trip'
            });
        expect(reqRes.status).toBe(201);
        expect(reqRes.body.status).toBe('pending');
        expect(reqRes.body.days).toBe(8);

        const approve = await request(app).put(`/v1/leave/requests/${reqRes.body.id}/approve`).set(hr);
        expect(approve.status).toBe(200);
        expect(approve.body.status).toBe('approved');

        const bal = state.leaveBalances.find((b) => b.employee_id === 5 && b.year === YEAR);
        expect(Number(bal.used)).toBe(8);
        expect(published.some((e) => e.type === 'strafor.leave.requested')).toBe(true);
        expect(published.some((e) => e.type === 'strafor.leave.decided' && e.payload.decision === 'approved')).toBe(
            true
        );

        // request beyond remaining balance (14-8=6 left) → 409
        const tooBig = await request(app)
            .post('/v1/leave/requests')
            .set(emp)
            .send({ leaveTypeCode: 'vacaciones', startDate: `${YEAR}-08-01`, endDate: `${YEAR}-08-10` });
        expect(tooBig.status).toBe(201);
        const denied = await request(app).put(`/v1/leave/requests/${tooBig.body.id}/approve`).set(hr);
        expect(denied.status).toBe(409);
        expect(denied.body.details.available).toBe(6);

        // manager can reject
        const reject = await request(app).put(`/v1/leave/requests/${tooBig.body.id}/reject`).set(asUser(2, 'manager'));
        expect(reject.status).toBe(200);
        expect(reject.body.status).toBe('rejected');
    });

    it('approving vacaciones without any balance row → 409', async () => {
        const { app } = makeTestApp();
        const reqRes = await request(app)
            .post('/v1/leave/requests')
            .set(asUser(9, 'employee'))
            .send({ leaveTypeCode: 'vacaciones', startDate: `${YEAR}-09-01`, endDate: `${YEAR}-09-02` });
        expect(reqRes.status).toBe(201);
        const res = await request(app).put(`/v1/leave/requests/${reqRes.body.id}/approve`).set(asUser(1, 'hr'));
        expect(res.status).toBe(409);
        expect(res.body.details.available).toBe(0);
    });

    it('non-approval types auto-approve; requests are scoped to the owner', async () => {
        const { app } = makeTestApp();
        const emp = asUser(5, 'employee');

        const auto = await request(app)
            .post('/v1/leave/requests')
            .set(emp)
            .send({ leaveTypeCode: 'incapacidad', startDate: `${YEAR}-05-01`, endDate: `${YEAR}-05-03` });
        expect(auto.status).toBe(201);
        expect(auto.body.status).toBe('approved'); // requires_approval=false → auto

        await request(app)
            .post('/v1/leave/requests')
            .set(asUser(9, 'employee'))
            .send({ leaveTypeCode: 'permiso', startDate: `${YEAR}-05-10`, endDate: `${YEAR}-05-10` });

        const mine = await request(app).get('/v1/leave/requests').set(emp);
        expect(mine.status).toBe(200);
        expect(mine.body.requests).toHaveLength(1);
        expect(mine.body.requests[0].employeeId).toBe(5);

        const all = await request(app).get('/v1/leave/requests').set(asUser(1, 'hr'));
        expect(all.status).toBe(200);
        expect(all.body.requests.length).toBeGreaterThanOrEqual(2);
    });

    it('cancel works on own pending request only', async () => {
        const { app } = makeTestApp();
        const emp = asUser(5, 'employee');
        const reqRes = await request(app)
            .post('/v1/leave/requests')
            .set(emp)
            .send({ leaveTypeCode: 'permiso', startDate: `${YEAR}-06-01`, endDate: `${YEAR}-06-01` });
        expect(reqRes.body.status).toBe('pending');

        const otherCancel = await request(app)
            .put(`/v1/leave/requests/${reqRes.body.id}/cancel`)
            .set(asUser(9, 'employee'));
        expect(otherCancel.status).toBe(403);

        const cancel = await request(app).put(`/v1/leave/requests/${reqRes.body.id}/cancel`).set(emp);
        expect(cancel.status).toBe(200);
        expect(cancel.body.status).toBe('cancelled');
    });

    it('accrue requires the service token — admin and users get 403, anon 401', async () => {
        const { app } = makeTestApp();
        const body = { employeeId: 5, hireDate: '2020-01-01' };

        const anon = await request(app).post('/v1/leave/accrue').send(body);
        expect(anon.status).toBe(401);

        const admin = await request(app).post('/v1/leave/accrue').set(asUser(1, 'admin')).send(body);
        expect(admin.status).toBe(403);

        const hrUser = await request(app).post('/v1/leave/accrue').set(asUser(1, 'hr')).send(body);
        expect(hrUser.status).toBe(403);

        const bad = await request(app).post('/v1/leave/accrue').set({ 'X-Service-Token': 'wrong' }).send(body);
        expect(bad.status).toBe(401);
    });

    it('accrue computes MX entitlement from hire_date', async () => {
        const { app, state } = makeTestApp();
        // hired 2020-06-15; at 2025-06-14 → 4 years → 18; at 2025-06-15 → 5 → 20; 2027 → 6 → 22
        const r1 = await request(app)
            .post('/v1/leave/accrue')
            .set(SVC)
            .send({ employeeId: 7, hireDate: '2020-06-15', asOf: '2025-06-14' });
        expect(r1.body.yearsOfService).toBe(4);
        expect(r1.body.entitled).toBe(18);
        expect(r1.body.year).toBe(2025);

        const r2 = await request(app)
            .post('/v1/leave/accrue')
            .set(SVC)
            .send({ employeeId: 7, hireDate: '2020-06-15', asOf: '2025-06-15' });
        expect(r2.body.yearsOfService).toBe(5);
        expect(r2.body.entitled).toBe(20);

        // upsert: the (7, vacaciones, 2025) row was updated, not duplicated
        const rows2025 = state.leaveBalances.filter((b) => b.employee_id === 7 && b.year === 2025);
        expect(rows2025).toHaveLength(1);
        expect(Number(rows2025[0].entitled)).toBe(20);

        const r3 = await request(app)
            .post('/v1/leave/accrue')
            .set(SVC)
            .send({ employeeId: 7, hireDate: '2020-06-15', asOf: '2027-01-01' });
        expect(r3.body.yearsOfService).toBe(6);
        expect(r3.body.entitled).toBe(22);

        // less than one year of service → 0 days
        const r4 = await request(app)
            .post('/v1/leave/accrue')
            .set(SVC)
            .send({ employeeId: 8, hireDate: '2026-01-01', asOf: '2026-06-01' });
        expect(r4.body.entitled).toBe(0);
    });

    it('balances: self sees own, hr can filter; admin → 403', async () => {
        const { app } = makeTestApp();
        await request(app)
            .post('/v1/leave/accrue')
            .set(SVC)
            .send({ employeeId: 5, hireDate: '2019-01-01', asOf: `${YEAR}-01-15` });
        await request(app)
            .post('/v1/leave/accrue')
            .set(SVC)
            .send({ employeeId: 9, hireDate: `${YEAR - 1}-01-01`, asOf: `${YEAR}-01-15` });

        const mine = await request(app).get('/v1/leave/balances').set(asUser(5, 'employee'));
        expect(mine.status).toBe(200);
        expect(mine.body.balances).toHaveLength(1);
        expect(mine.body.balances[0].employeeId).toBe(5);
        expect(mine.body.balances[0].available).toBe(mine.body.balances[0].entitled);

        const all = await request(app).get('/v1/leave/balances').set(asUser(1, 'hr'));
        expect(all.body.balances.length).toBeGreaterThanOrEqual(2);

        const admin = await request(app).get('/v1/leave/balances').set(asUser(1, 'admin'));
        expect(admin.status).toBe(403);
    });
});
