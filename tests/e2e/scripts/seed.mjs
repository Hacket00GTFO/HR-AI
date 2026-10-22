// Seed the two live-stack E2E users into strafor_identity.
//
//   node scripts/seed.mjs
//
// Idempotent: upserts by email and always refreshes the password hash, so the
// suite keeps working after a password change in .env or a stale seed.
//
// Env (all optional — same defaults as helpers/env.ts):
//   E2E_IDENTITY_DATABASE_URL   postgres://…/strafor_identity
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD   (default e2e.admin@strafor.test / E2e-Test!234)
//   E2E_HR_EMAIL / E2E_HR_PASSWORD         (default e2e.hr@strafor.test / E2e-Test!234)
//   POSTGRES_USER / POSTGRES_PASSWORD      fallbacks read from the repo-root .env
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadDotEnv(file) {
    const out = {};
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let v = (m[2] ?? '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out[m[1]] = v;
    }
    return out;
}

const rootEnv = loadDotEnv(path.join(REPO_ROOT, '.env'));
const dbUrl =
    process.env.E2E_IDENTITY_DATABASE_URL ??
    `postgres://${rootEnv.POSTGRES_USER ?? 'strafor'}:${rootEnv.POSTGRES_PASSWORD ?? 'postgres'}@localhost:5433/strafor_identity`;

const users = [
    {
        email: (process.env.E2E_ADMIN_EMAIL ?? 'e2e.admin@strafor.test').toLowerCase(),
        password: process.env.E2E_ADMIN_PASSWORD ?? 'E2e-Test!234',
        role: 'admin',
        firstName: 'E2E',
        lastName: 'Admin'
    },
    {
        email: (process.env.E2E_HR_EMAIL ?? 'e2e.hr@strafor.test').toLowerCase(),
        password: process.env.E2E_HR_PASSWORD ?? 'E2e-Test!234',
        role: 'hr',
        firstName: 'E2E',
        lastName: 'Hr'
    }
];

const pool = new pg.Pool({ connectionString: dbUrl });
try {
    for (const u of users) {
        const hash = await bcrypt.hash(u.password, 10);
        const res = await pool.query(
            `INSERT INTO users (first_name, last_name, email, password, role)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (email) DO UPDATE
               SET password = EXCLUDED.password,
                   role = EXCLUDED.role,
                   active = TRUE,
                   deleted_at = NULL
             RETURNING id`,
            [u.firstName, u.lastName, u.email, hash, u.role]
        );
        console.log(`seeded ${u.role} ${u.email} (id=${res.rows[0].id})`);
    }
} finally {
    await pool.end();
}
