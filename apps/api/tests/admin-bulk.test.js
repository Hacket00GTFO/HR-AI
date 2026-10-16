// Input-validation tests for /api/admin/bulk — malformed bodies must 400
// before they reach the model layer (previously candidate_ids.length on an
// undefined array produced a 500).
// Runs WITHOUT a live database: db.query is stubbed, so a request that PASSES
// validation fails inside BulkOperation.create with a 500 — which is exactly
// the signal that validation let it through.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-vitest';
process.env.ALLOW_LEGACY_HS256 = 'true';

const require = createRequire(import.meta.url);
const db = require('../db/index.js');
const serviceClient = require('../utils/serviceClient.js');

db.query = vi.fn(async (text) => {
    if (typeof text === 'string' && text.includes('SELECT logged_out, active FROM users')) {
        return { rows: [{ logged_out: false, active: true }] };
    }
    throw new Error('no database in admin-bulk tests');
});
serviceClient.callIdentity = vi.fn(async () => ({ status: 200, data: {} }));

let app;
let hrToken;
let adminToken;

beforeAll(async () => {
    const server = await import('../server.js');
    app = server.app;
    server.setDbConnected(true);

    const jwt = require('jsonwebtoken');
    hrToken = jwt.sign({ id: 2, email: 'hr@test.local', role: 'hr' }, process.env.JWT_SECRET);
    adminToken = jwt.sign({ id: 1, email: 'admin@test.local', role: 'admin' }, process.env.JWT_SECRET);
}, 30000);

const asHr = () => ({ Authorization: `Bearer ${hrToken}` });
const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

describe('bulk status-change validation', () => {
    it.each([
        ['missing candidate_ids', { new_status: 'accepted' }],
        ['empty candidate_ids', { candidate_ids: [], new_status: 'accepted' }],
        ['non-array candidate_ids', { candidate_ids: 'abc', new_status: 'accepted' }],
        ['non-integer ids', { candidate_ids: ['a', 'b'], new_status: 'accepted' }],
        ['missing new_status', { candidate_ids: [1, 2] }]
    ])('%s → 400', async (_label, body) => {
        const res = await request(app).post('/api/admin/bulk/status-change').set(asHr()).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
    });

    it('valid body passes validation (500 from stubbed db, not 400)', async () => {
        const res = await request(app)
            .post('/api/admin/bulk/status-change')
            .set(asHr())
            .send({ candidate_ids: [1, 2, 3], new_status: 'accepted' });
        expect(res.status).toBe(500); // reached BulkOperation.create → stub threw
    });
});

describe('bulk archive/delete validation', () => {
    it.each([
        ['archive', { entity_type: 'candidates' }],
        ['archive', { entity_type: 'candidates', ids: [] }],
        ['archive', { ids: [1] }],
        ['delete', { entity_type: 'candidates', ids: 'x' }],
        ['delete', { entity_type: 'candidates', ids: [0, -1] }]
    ])('POST /api/admin/bulk/%s %j → 400', async (path, body) => {
        const res = await request(app).post(`/api/admin/bulk/${path}`).set(asHr()).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
    });

    it('valid archive body passes validation', async () => {
        const res = await request(app)
            .post('/api/admin/bulk/archive')
            .set(asHr())
            .send({ entity_type: 'candidates', ids: [4, 5] });
        expect(res.status).toBe(500); // reached the model → stub threw
    });
});

describe('bulk role guard is unchanged', () => {
    it('admin cannot create bulk jobs (isHR, not isAdmin)', async () => {
        const res = await request(app)
            .post('/api/admin/bulk/status-change')
            .set(asAdmin())
            .send({ candidate_ids: [1], new_status: 'accepted' });
        expect(res.status).toBe(403);
    });

    it('staff can still list bulk operations', async () => {
        const res = await request(app).get('/api/admin/bulk').set(asAdmin());
        expect(res.status).toBe(500); // isStaff passed, db stub threw
    });
});
