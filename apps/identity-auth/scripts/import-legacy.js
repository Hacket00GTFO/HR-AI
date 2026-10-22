#!/usr/bin/env node
require('dotenv').config();
/**
 * import-legacy — copy `users` + `settings` from the monolith database into
 * the identity database, PRESERVING ids so identity users.id stays aligned
 * with FK references (vacancies.created_by_user_id, applications.created_by,
 * audit_logs.actor_user_id, ...) in the monolith DB.
 *
 *   SOURCE_DATABASE_URL=postgres://.../innovation \
 *   DATABASE_URL=postgres://.../strafor_identity \
 *   node scripts/import-legacy.js
 *
 * Idempotent: rows that already exist (same id) are skipped. Emails are
 * lowercased to match the identity invariant.
 */
const { Client } = require('pg');

const SOURCE = process.env.SOURCE_DATABASE_URL;
const TARGET = process.env.DATABASE_URL;

if (!SOURCE || !TARGET) {
    console.error('SOURCE_DATABASE_URL (monolith) and DATABASE_URL (identity) are both required.');
    process.exit(1);
}

async function main() {
    const src = new Client({ connectionString: SOURCE });
    const dst = new Client({ connectionString: TARGET });
    await src.connect();
    await dst.connect();

    try {
        const { rows: users } = await src.query(`
            SELECT id, first_name, last_name, lower(email) AS email, password, role,
                   location, last_login, logged_out, active, created_at, updated_at, deleted_at
            FROM users ORDER BY id
        `);

        let inserted = 0;
        let skipped = 0;
        await dst.query('BEGIN');
        try {
            for (const u of users) {
                const res = await dst.query(
                    `INSERT INTO users (id, first_name, last_name, email, password, role, location,
                                        last_login, logged_out, active, created_at, updated_at, deleted_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                     ON CONFLICT (id) DO NOTHING`,
                    [
                        u.id,
                        u.first_name,
                        u.last_name,
                        u.email,
                        u.password,
                        u.role,
                        u.location ? JSON.stringify(u.location) : null,
                        u.last_login,
                        u.logged_out ?? false,
                        u.active ?? true,
                        u.created_at,
                        u.updated_at,
                        u.deleted_at
                    ]
                );
                if (res.rowCount === 1) inserted += 1;
                else skipped += 1;
            }

            // Keep the sequence ahead of the highest imported id.
            await dst.query(
                `SELECT setval(pg_get_serial_sequence('users','id'),
                               COALESCE((SELECT MAX(id) FROM users), 1))`
            );

            const { rows: settings } = await src.query(`
                SELECT id, user_id, company, linkedin, occ, theme, notifications,
                       created_at, updated_at
                FROM settings ORDER BY id
            `);

            let sInserted = 0;
            let sSkipped = 0;
            for (const s of settings) {
                const res = await dst.query(
                    `INSERT INTO settings (id, user_id, company, linkedin, occ, theme,
                                           notifications, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                     ON CONFLICT (id) DO NOTHING`,
                    [
                        s.id,
                        s.user_id,
                        s.company ? JSON.stringify(s.company) : null,
                        s.linkedin ? JSON.stringify(s.linkedin) : null,
                        s.occ ? JSON.stringify(s.occ) : null,
                        s.theme,
                        s.notifications,
                        s.created_at,
                        s.updated_at
                    ]
                );
                if (res.rowCount === 1) sInserted += 1;
                else sSkipped += 1;
            }
            await dst.query(
                `SELECT setval(pg_get_serial_sequence('settings','id'),
                               COALESCE((SELECT MAX(id) FROM settings), 1))`
            );

            await dst.query('COMMIT');
            console.log(`users: ${inserted} imported, ${skipped} already present`);
            console.log(`settings: ${sInserted} imported, ${sSkipped} already present`);
        } catch (err) {
            await dst.query('ROLLBACK');
            throw err;
        }
    } finally {
        await src.end();
        await dst.end();
    }
}

main().catch((err) => {
    console.error('Import failed:', err.message || err);
    process.exit(1);
});
