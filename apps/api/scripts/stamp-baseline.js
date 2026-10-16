require('dotenv').config();
const { Client } = require('pg');

/**
 * Stamp migration 0001_baseline on a database that was provisioned by the old
 * schema.sql bootstrap (db/initSchema or the docker initdb mount) BEFORE
 * node-pg-migrate existed.
 *
 * Detection: the legacy tables exist but pgmigrations has no baseline row.
 * Safe to run repeatedly — it does nothing when the baseline is already
 * recorded or when the database is empty (fresh installs run 0001 for real).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/stamp-baseline.js
 *   # equivalent CLI alternative:
 *   # node-pg-migrate up 0001_baseline --fake
 */

const BASELINE = '0001_baseline';
const LEGACY_TABLES = ['users', 'settings', 'vacancies', 'candidates'];

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is required.');
        process.exit(1);
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        const { rows: tables } = await client.query(
            `SELECT COUNT(*)::int AS n
             FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = ANY($1)`,
            [LEGACY_TABLES]
        );
        const legacyPresent = tables[0].n === LEGACY_TABLES.length;

        const { rows: migTable } = await client.query(`SELECT to_regclass('public.pgmigrations') AS t`);
        const pgmExists = migTable[0].t !== null;

        let alreadyStamped = false;
        if (pgmExists) {
            const { rows } = await client.query('SELECT 1 FROM pgmigrations WHERE name = $1', [BASELINE]);
            alreadyStamped = rows.length > 0;
        }

        if (alreadyStamped) {
            console.log(`Baseline '${BASELINE}' is already recorded — nothing to do.`);
            return;
        }
        if (!legacyPresent) {
            console.log('Legacy tables not found — this looks like a fresh database.');
            console.log('Do NOT stamp; just run `pnpm --filter @strafor/api migrate` (0001 will run for real).');
            return;
        }

        // Fresh databases legitimately reach this point only if pgmigrations is
        // missing entirely — create it in node-pg-migrate's own format.
        await client.query(`
            CREATE TABLE IF NOT EXISTS pgmigrations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                run_on TIMESTAMP NOT NULL
            )
        `);
        await client.query('INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())', [BASELINE]);
        console.log(`Stamped '${BASELINE}' as applied. Run \`pnpm --filter @strafor/api migrate\` to apply the rest.`);
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('stamp-baseline failed:', err.message);
    process.exit(1);
});
