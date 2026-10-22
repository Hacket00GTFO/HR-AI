// Persona-level E2E: what each role can actually DO end-to-end.
//
//   candidate/anon — public surface only, through the gateway.
//   admin          — platform administration; 403 on ALL business data.
//   hr             — full HR business access; 403 on admin-only surfaces.
//   employee       — self-service only; scoped to own employee record.
//   manager        — self-service + reviewer surfaces (corrections/leave).
//   service        — X-Service-Token; internal routes only.
//
// employee/manager/candidate cannot be minted as JWTs (identity users.role is
// CHECK-constrained to admin/hr), so those personas are exercised through the
// direct layer with the asserted identity headers the gateway would inject.
import { describe, it, expect, beforeAll } from 'vitest';
import { config, liveGateway, liveService, type ServiceKey } from './helpers/env.js';
import { req } from './helpers/http.js';
import { asserted, bearer, serviceAuth } from './helpers/token.js';
import { newCtx, type Ctx } from './helpers/matrix.js';
import { acquireTokens, linkEmployeeDirectory, SUITE_PERSONAS } from './helpers/setup.js';
import { record, resetResults } from './helpers/report.js';

const ctx: Ctx = newCtx();
let gatewayUp = false;
let linked = false;
const up: Partial<Record<ServiceKey, boolean>> = {};

// it.each callbacks receive only the tuple elements — no TestContext — so a
// down service must be handled by early return, not t.skip().
async function svcUp(key: ServiceKey): Promise<boolean> {
    if (up[key] === undefined) up[key] = await liveService(key);
    return up[key] === true;
}

function note(row: {
    caseId: string;
    service: string;
    via: 'gateway' | 'direct';
    method: string;
    path: string;
    guard: string;
    persona: Parameters<typeof record>[0]['persona'];
    expected: number[];
    actual: number;
    note?: string;
}): void {
    record({
        suite: SUITE_PERSONAS,
        tolerated: [],
        ...row,
        verdict: row.expected.includes(row.actual) ? 'ok' : row.actual === 429 ? 'tolerated' : 'fail',
        note: row.note ?? (row.actual === 429 ? 'rate-limited — guard not evaluated' : '')
    });
}

beforeAll(async () => {
    resetResults(SUITE_PERSONAS);
    gatewayUp = await liveGateway();
    if (gatewayUp) {
        await acquireTokens(ctx);
    }
    if (config.serviceToken && (await liveService('hrServices'))) {
        linked = await linkEmployeeDirectory(ctx);
    }
});

// ---------------------------------------------------------------------------
describe('persona: candidate / anonymous (gateway)', () => {
    it('GET /api/v1/vacancies → 200 (public careers listing)', async (t) => {
        if (!gatewayUp) return t.skip();
        const r = await req(config.baseUrl, '/api/v1/vacancies');
        note({
            caseId: 'persona/anon-vacancies',
            service: 'recruitment-core',
            via: 'gateway',
            method: 'GET',
            path: '/api/v1/vacancies',
            guard: 'public allowlist',
            persona: 'anon',
            expected: [200],
            actual: r.status
        });
        expect(r.status).toBe(200);
    });

    it('POST /api/v1/public/apply is reachable anonymously (validation 4xx OK)', async (t) => {
        if (!gatewayUp) return t.skip();
        const r = await req(config.baseUrl, '/api/v1/public/apply', { method: 'POST', body: {} });
        note({
            caseId: 'persona/anon-apply',
            service: 'recruitment-core',
            via: 'gateway',
            method: 'POST',
            path: '/api/v1/public/apply',
            guard: 'public allowlist (POST)',
            persona: 'anon',
            expected: [200, 201, 400, 413, 415, 422],
            actual: r.status
        });
        expect([200, 201, 400, 413, 415, 422]).toContain(r.status);
    });

    it('GET /api/v1/users → 401 (identity admin surface stays closed)', async (t) => {
        if (!gatewayUp) return t.skip();
        const r = await req(config.baseUrl, '/api/v1/users');
        note({
            caseId: 'persona/anon-users',
            service: 'identity-auth',
            via: 'gateway',
            method: 'GET',
            path: '/api/v1/users',
            guard: 'requireAdmin',
            persona: 'anon',
            expected: [401],
            actual: r.status
        });
        expect(r.status).toBe(401);
    });

    it('GET /api/v1/candidates → 401 (candidate PII never public)', async (t) => {
        if (!gatewayUp) return t.skip();
        const r = await req(config.baseUrl, '/api/v1/candidates');
        expect(r.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
describe('persona: admin (gateway, real JWT)', () => {
    it('GET /api/admin/audit → 200 (admin-only monolith route)', async (t) => {
        if (!gatewayUp || !ctx.tokens.admin) return t.skip();
        const r = await req(config.baseUrl, '/api/admin/audit', { headers: bearer(ctx.tokens.admin) });
        note({
            caseId: 'persona/admin-audit',
            service: 'api',
            via: 'gateway',
            method: 'GET',
            path: '/api/admin/audit',
            guard: 'isAdmin',
            persona: 'admin',
            expected: [200],
            actual: r.status
        });
        expect(r.status).toBe(200);
    });

    it('GET /api/v1/users → 200 (identity admin surface)', async (t) => {
        if (!gatewayUp || !ctx.tokens.admin) return t.skip();
        const r = await req(config.baseUrl, '/api/v1/users', { headers: bearer(ctx.tokens.admin) });
        expect(r.status).toBe(200);
    });

    it.each([
        ['/api/v1/employees', 'hr-core'],
        ['/api/v1/attendance/mine', 'time-attendance'],
        ['/api/v1/payroll/periods', 'payroll-adapter'],
        ['/api/v1/tickets', 'hr-services'],
        ['/api/v1/tickets/my', 'hr-services'],
        ['/api/v1/documents/1', 'documents-resumes']
    ])('GET %s → 403 (admin barred from business data)', async (path, service) => {
        if (!gatewayUp || !ctx.tokens.admin) return;
        const r = await req(config.baseUrl, path, { headers: bearer(ctx.tokens.admin) });
        note({
            caseId: `persona/admin-${service}`,
            service: String(service),
            via: 'gateway',
            method: 'GET',
            path: String(path),
            guard: 'role guard',
            persona: 'admin',
            expected: [403],
            actual: r.status
        });
        expect(r.status).toBe(403);
    });
});

// ---------------------------------------------------------------------------
describe('persona: hr (gateway, real JWT)', () => {
    it('GET /api/v1/employees → 200 (HR business route)', async (t) => {
        if (!gatewayUp || !ctx.tokens.hr) return t.skip();
        const r = await req(config.baseUrl, '/api/v1/employees', { headers: bearer(ctx.tokens.hr) });
        expect(r.status).toBe(200);
    });

    it.each([
        ['/api/admin/audit', 'api'],
        ['/api/v1/users', 'identity-auth'],
        ['/api/v1/notifications', 'notifications']
    ])('GET %s → 403 (admin-only surfaces reject hr)', async (path, service) => {
        if (!gatewayUp || !ctx.tokens.hr) return;
        const r = await req(config.baseUrl, path, { headers: bearer(ctx.tokens.hr) });
        note({
            caseId: `persona/hr-${service}-adminonly`,
            service: String(service),
            via: 'gateway',
            method: 'GET',
            path: String(path),
            guard: 'admin-only',
            persona: 'hr',
            expected: [403],
            actual: r.status
        });
        expect(r.status).toBe(403);
    });
});

// ---------------------------------------------------------------------------
describe('persona: employee (direct layer — asserted gateway identity)', () => {
    const emp = () => asserted('employee', ctx.ids.employeeA);

    it.each<[ServiceKey, string]>([
        ['timeAttendance', '/v1/attendance/mine'],
        ['timeAttendance', '/v1/leave/types'],
        ['timeAttendance', '/v1/leave/requests'],
        ['timeAttendance', '/v1/leave/balances'],
        ['hrServices', '/v1/tickets/my'],
        ['hrServices', '/v1/expenses/my'],
        ['hrServices', '/v1/assets/my'],
        ['hrServices', '/v1/surveys/open']
    ])('CAN read %s%s → non-401/403', async (base, path) => {
        if (!(await svcUp(base))) return;
        const r = await req(config.services[base], path, { headers: emp() });
        note({
            caseId: `persona/employee-can-${base}${path}`,
            service: base,
            via: 'direct',
            method: 'GET',
            path,
            guard: 'self-service',
            persona: 'employee',
            expected: [200],
            actual: r.status
        });
        expect(r.status).toBe(200);
    });

    it.each<[ServiceKey, string, string]>([
        ['payroll', 'POST', '/v1/payroll/periods'],
        ['payroll', 'GET', '/v1/payroll/periods'],
        ['payroll', 'GET', '/v1/payroll/fiscal/1'],
        ['hrServices', 'GET', '/v1/tickets'],
        ['hrServices', 'GET', '/v1/expenses'],
        ['timeAttendance', 'GET', '/v1/schedules'],
        ['timeAttendance', 'PUT', '/v1/attendance/corrections/1/approve'],
        ['hrCore', 'GET', '/v1/employees']
    ])('CANNOT %s %s → 403 (HR/reviewer-only surface)', async (base, method, path) => {
        if (!(await svcUp(base))) return;
        const r = await req(config.services[base], path, {
            method,
            headers: emp(),
            body: method === 'GET' ? undefined : {}
        });
        note({
            caseId: `persona/employee-deny-${base}${path}`,
            service: base,
            via: 'direct',
            method,
            path,
            guard: 'hr/reviewer guard',
            persona: 'employee',
            expected: [403],
            actual: r.status
        });
        expect(r.status).toBe(403);
    });

    it('CANNOT read another employee’s ticket (self-scope → 404)', async (t) => {
        if (!(await svcUp('hrServices'))) return;
        if (!linked) return t.skip();
        // employee A creates a ticket…
        const create = await req(config.services.hrServices, '/v1/tickets/my', {
            method: 'POST',
            headers: asserted('employee', ctx.ids.employeeA),
            body: { subject: 'E2E scope probe', description: 'owned by employee A', priority: 'normal' }
        });
        expect(create.status).toBe(201);
        const ticketId = (create.body as { id: number }).id;
        // …employee B must not see it (scoped query → 404, not 403 leak of existence).
        const read = await req(config.services.hrServices, `/v1/tickets/my/${ticketId}`, {
            headers: asserted('employee', ctx.ids.employeeB)
        });
        note({
            caseId: 'persona/employee-cross-scope',
            service: 'hr-services',
            via: 'direct',
            method: 'GET',
            path: `/v1/tickets/my/${ticketId}`,
            guard: 'requireEmployee + scoped query',
            persona: 'employee',
            expected: [404],
            actual: read.status
        });
        expect(read.status).toBe(404);
        // …and employee A can read it back (positive control).
        const own = await req(config.services.hrServices, `/v1/tickets/my/${ticketId}`, {
            headers: asserted('employee', ctx.ids.employeeA)
        });
        expect(own.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe('persona: manager (direct layer)', () => {
    const mgr = () => asserted('manager', ctx.ids.manager);

    it('CAN review corrections/leave → non-403 on reviewer routes', async (t) => {
        if (!(await svcUp('timeAttendance'))) return;
        const r = await req(config.services.timeAttendance, '/v1/attendance/corrections/999999/approve', {
            method: 'PUT',
            headers: mgr(),
            body: {}
        });
        note({
            caseId: 'persona/manager-reviewer',
            service: 'time-attendance',
            via: 'direct',
            method: 'PUT',
            path: '/v1/attendance/corrections/999999/approve',
            guard: 'requireReviewer',
            persona: 'manager',
            expected: [200, 400, 404, 422],
            actual: r.status
        });
        expect([200, 400, 404, 422]).toContain(r.status);
    });

    it('CANNOT touch HR-only schedule management → 403', async (t) => {
        if (!(await svcUp('timeAttendance'))) return;
        const r = await req(config.services.timeAttendance, '/v1/schedules', { headers: mgr() });
        expect(r.status).toBe(403);
    });

    it('CANNOT touch payroll → 403', async (t) => {
        if (!(await svcUp('payroll'))) return;
        const r = await req(config.services.payroll, '/v1/payroll/periods', { headers: mgr() });
        expect(r.status).toBe(403);
    });
});

// ---------------------------------------------------------------------------
describe('persona: service token (direct layer)', () => {
    it('accepted on /v1/internal/* (hr-core users-projection)', async (t) => {
        if (!config.serviceToken || !(await svcUp('hrCore'))) return t.skip();
        const r = await req(config.services.hrCore, '/v1/internal/users-projection', {
            method: 'POST',
            headers: serviceAuth(),
            body: {}
        });
        note({
            caseId: 'persona/service-internal',
            service: 'hr-core',
            via: 'direct',
            method: 'POST',
            path: '/v1/internal/users-projection',
            guard: 'requireService',
            persona: 'service',
            expected: [200, 400],
            actual: r.status
        });
        expect([200, 400]).toContain(r.status); // 400 = payload validation → authz passed
    });

    it('user identity is REJECTED on /v1/internal/* → 401', async (t) => {
        if (!(await svcUp('hrCore'))) return;
        const r = await req(config.services.hrCore, '/v1/internal/users-projection', {
            method: 'POST',
            headers: asserted('hr', ctx.userIds.hr),
            body: {}
        });
        expect(r.status).toBe(401);
    });

    it('through the gateway a service token alone is stripped → 401', async (t) => {
        if (!gatewayUp || !config.serviceToken) return t.skip();
        const r = await req(config.baseUrl, '/api/v1/employees', { headers: serviceAuth() });
        expect(r.status).toBe(401);
    });
});
