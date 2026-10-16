// HR list-endpoint filter tests: query params are allowlisted — arbitrary
// keys never reach the SQL, and ?q= runs an ILIKE search on declared columns
// instead of being treated as a column name.
// Runs WITHOUT a live database — db.query is stubbed before the app loads.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-vitest';
process.env.ALLOW_LEGACY_HS256 = 'true';

const require = createRequire(import.meta.url);
const db = require('../db/index.js');

db.query = vi.fn(async (text) => {
    if (typeof text === 'string' && text.includes('SELECT logged_out, active FROM users')) {
        return { rows: [{ logged_out: false, active: true }] };
    }
    return { rows: [] };
});

let app;
let hrToken;

beforeAll(async () => {
    const server = await import('../server.js');
    app = server.app;
    server.setDbConnected(true);
    const jwt = require('jsonwebtoken');
    hrToken = jwt.sign({ id: 2, email: 'hr@test.local', role: 'hr' }, process.env.JWT_SECRET);
}, 60000);

const asHr = () => ({ Authorization: `Bearer ${hrToken}` });
const lastSql = () => db.query.mock.calls.at(-1)[0];

beforeEach(() => {
    db.query.mockClear();
});

describe('HR list filters — column names never come from the client', () => {
    it('?q= performs an ILIKE search on allowlisted columns, not a column lookup', async () => {
        const res = await request(app).get('/api/hr/employees?q=ana').set(asHr());
        expect(res.status).toBe(200);
        const sql = lastSql();
        expect(sql).toContain('ILIKE');
        expect(sql).not.toMatch(/employees\.q\s*=/);
        expect(db.query.mock.calls.at(-1)[1]).toEqual(['%ana%']);
    });

    it('ignores non-allowlisted filter keys (would-be injection)', async () => {
        const res = await request(app).get('/api/hr/employees?password_hash=x&role=admin;DROP').set(asHr());
        expect(res.status).toBe(200);
        const sql = lastSql();
        expect(sql).not.toContain('password_hash');
        expect(sql).not.toContain('role');
        expect(sql).toContain('deleted_at IS NULL');
    });

    it('applies allowlisted equality filters', async () => {
        const res = await request(app).get('/api/hr/employees?status=active&department=IT').set(asHr());
        expect(res.status).toBe(200);
        const sql = lastSql();
        expect(sql).toContain('employees.status = $1');
        expect(sql).toContain('employees.department = $2');
    });

    it('?q= on a module without searchColumns is ignored cleanly', async () => {
        const res = await request(app).get('/api/hr/attendance?q=test').set(asHr());
        expect(res.status).toBe(200);
        expect(lastSql()).not.toContain('ILIKE');
    });

    it('still requires HR role (admin → 403)', async () => {
        const jwt = require('jsonwebtoken');
        const adminToken = jwt.sign({ id: 1, role: 'admin' }, process.env.JWT_SECRET);
        const res = await request(app)
            .get('/api/hr/employees')
            .set({ Authorization: `Bearer ${adminToken}` });
        expect(res.status).toBe(403);
    });
});
