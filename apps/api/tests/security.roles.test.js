// Role-matrix tests: strict Admin vs HR separation.
//   isHR  → only role 'hr'    (admins no longer inherit HR capabilities)
//   isAdmin → only role 'admin'
// Runs WITHOUT a live database or identity service — the db module's query
// is stubbed so token revocation passes, and role checks happen before any
// DB/service call, so 403 vs not-403 is deterministic.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-vitest';
// Legacy HS256 tokens are only accepted with this flag — required here to
// mint valid tokens without the identity service (RS256/JWKS).
process.env.ALLOW_LEGACY_HS256 = 'true';

const require = createRequire(import.meta.url);
const db = require('../db/index.js');
const serviceClient = require('../utils/serviceClient.js');

// Stub the shared db module BEFORE the server is imported:
// - the token revocation lookup returns an active, logged-in user;
// - every other query fails fast (routes that pass the role check respond
//   4xx/5xx, which is exactly what the "not 403" assertions expect).
db.query = vi.fn(async (text) => {
    if (typeof text === 'string' && text.includes('SELECT logged_out, active FROM users')) {
        return { rows: [{ logged_out: false, active: true }] };
    }
    throw new Error('no database in role-matrix tests');
});

// Stub identity-service calls BEFORE routes load (they destructure
// callIdentity at require time). Admin routes proxy to identity-auth;
// without this the test outcome would depend on Docker being up.
serviceClient.callIdentity = vi.fn(async () => ({ status: 200, data: { data: [] } }));

let app;
let adminToken;
let hrToken;

beforeAll(async () => {
    const server = await import('../server.js');
    app = server.app;
    server.setDbConnected(true); // bypass the 503 DB guard

    const jwt = require('jsonwebtoken');
    adminToken = jwt.sign({ id: 1, email: 'admin@test.local', role: 'admin' }, process.env.JWT_SECRET);
    hrToken = jwt.sign({ id: 2, email: 'hr@test.local', role: 'hr' }, process.env.JWT_SECRET);
}, 30000);

// Header factories — evaluated lazily inside each request, after beforeAll
// has minted the tokens (a module-level `Bearer ${token}` captures undefined).
const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });
const asHr = () => ({ Authorization: `Bearer ${hrToken}` });

describe('role matrix — admin is locked out of HR tools', () => {
    it.each([
        ['post', '/api/vacancies'],
        ['get', '/api/vacancies/1'],
        ['put', '/api/vacancies/1'],
        ['delete', '/api/vacancies/1'],
        ['get', '/api/vacancies/1/candidates'],
        ['get', '/api/vacancies/1/top-candidates'],
        ['get', '/api/vacancies/1/applications'],
        ['get', '/api/candidates'],
        ['get', '/api/candidates/1/resume'],
        ['put', '/api/candidates/1/status'],
        ['post', '/api/ai/process-feedback'],
        ['get', '/api/dashboard/activity'],
        ['get', '/api/dashboard/application-trends'],
        ['get', '/api/dashboard/department-stats'],
        ['get', '/api/dashboard/generate-report'],
        ['get', '/api/hr/employees'],
        ['get', '/api/hr/attendance'],
        ['get', '/api/hr/leave-requests'],
        ['get', '/api/hr/performance-reviews'],
        ['get', '/api/hr/training-programs'],
        ['get', '/api/hr/payroll'],
        ['get', '/api/hr/benefit-plans']
    ])('%s %s → 403 for admin', async (method, url) => {
        const res = await request(app)[method](url).set(asAdmin()).send({});
        expect(res.status).toBe(403);
    });
});

describe('role matrix — HR is locked out of admin tools', () => {
    it.each([
        ['get', '/api/hr-accounts'],
        ['get', '/api/admin-accounts'],
        ['post', '/api/auth/register'],
        ['get', '/api/settings'],
        ['post', '/api/settings/company'],
        ['get', '/api/settings/api-config'],
        ['post', '/api/settings/linkedin-config'],
        ['post', '/api/settings/occ-config'],
        ['get', '/api/dashboard/admin/summary'],
        ['get', '/api/dashboard/admin/audit']
    ])('%s %s → 403 for HR', async (method, url) => {
        const res = await request(app)[method](url).set(asHr()).send({});
        expect(res.status).toBe(403);
    });
});

describe('role matrix — each role passes its own gate', () => {
    it('POST /api/vacancies with HR token → passes role check (400 schema, not 403)', async () => {
        const res = await request(app).post('/api/vacancies').set(asHr()).send({});
        expect(res.status).not.toBe(403);
        expect(res.status).toBe(400); // empty body fails vacancyCreateBody validation
    });

    it.each([
        ['get', '/api/vacancies/1/candidates'],
        ['get', '/api/hr/employees'],
        ['get', '/api/dashboard/activity']
    ])('%s %s with HR token → not 403 (DB stub error surfaces)', async (method, url) => {
        const res = await request(app)[method](url).set(asHr());
        expect(res.status).not.toBe(403);
        expect(res.status).toBe(500); // stubbed db.query throws past the role check
    });

    it.each([
        ['get', '/api/hr-accounts'],
        ['get', '/api/dashboard/admin/summary'],
        ['get', '/api/dashboard/admin/audit'],
        ['get', '/api/settings']
    ])('%s %s with admin token → 200 via stubbed identity proxy', async (method, url) => {
        const res = await request(app)[method](url).set(asAdmin());
        expect(res.status).toBe(200); // role gate passed, callIdentity stubbed
    });
});
