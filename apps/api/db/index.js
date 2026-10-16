require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');
const logger = require('../utils/logger');

if (!process.env.DATABASE_URL) {
    throw new Error(
        'DATABASE_URL environment variable is required (e.g. postgres://user:pass@host:5432/dbname). ' +
            'See .env.example.'
    );
}

// SSL config: PGSSLMODE=disable|require|no-verify|verify-full, or
// DATABASE_SSL=true|false as a simpler toggle. Connection strings may also
// carry ?sslmode=... — an explicit env var wins.
function resolveSsl() {
    const mode = (process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase();
    if (!mode || mode === 'disable' || mode === 'false' || mode === 'prefer') {
        return undefined; // defer to the connection string / server default
    }
    if (mode === 'require' || mode === 'true' || mode === 'no-verify') {
        return { rejectUnauthorized: false };
    }
    // verify-ca / verify-full: real TLS verification
    return { rejectUnauthorized: true };
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number.parseInt(process.env.PG_POOL_MAX, 10) || 10,
    idleTimeoutMillis: Number.parseInt(process.env.PG_IDLE_TIMEOUT_MS, 10) || 30000,
    connectionTimeoutMillis: Number.parseInt(process.env.PG_CONN_TIMEOUT_MS, 10) || 5000,
    keepAlive: true,
    ssl: resolveSsl(),
    application_name: 'strafor-api'
});

// Idle-client errors would otherwise crash the process with an unhandled error.
pool.on('error', (err) => {
    logger.error('Unexpected PostgreSQL idle client error:', err.message);
});

// Map a DB row to the API shape (adds _id for frontend compatibility with the
// old MongoDB ids).
// TODO(contract): the legacy frontend in apps/api/public still keys on `_id`;
// drop this once the frontend moves to `id`.
function withId(row) {
    if (!row) return row;
    row._id = String(row.id);
    return row;
}

async function query(text, params) {
    return pool.query(text, params);
}

// Run `fn(client)` inside a transaction. The client is a plain pg Client —
// pass it down to model methods that accept an optional `client` argument.
async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* already rolled back */
        }
        throw err;
    } finally {
        client.release();
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry forever with capped linear-ish backoff — never process.exit(). The
// server stays up and /api/health reports db:'down' until this resolves.
async function waitForConnection() {
    let attempt = 0;
    for (;;) {
        try {
            await pool.query('SELECT 1');
            logger.info('Connected to PostgreSQL successfully');
            return;
        } catch (err) {
            attempt += 1;
            const delay = Math.min(15000, 1000 * attempt);
            logger.error(`PostgreSQL connection error: ${err.message}`);
            logger.info(`Retrying connection in ${delay / 1000}s (attempt ${attempt})`);
            await sleep(delay);
        }
    }
}

// Apply all pending node-pg-migrate migrations. Runs at app boot so a fresh
// `docker compose up` yields a fully migrated database. For databases created
// by the old schema.sql bootstrap, stamp the baseline first:
//   node scripts/stamp-baseline.js
async function runMigrations() {
    // Lazy require so unit tests that never touch the DB don't load the
    // migration runner (and so a missing package fails only on boot paths).
    const { runner } = require('node-pg-migrate');
    const migrations = await runner({
        databaseUrl: process.env.DATABASE_URL,
        dir: path.join(__dirname, '..', 'migrations'),
        direction: 'up',
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
        schema: 'public',
        verbose: false,
        log: (msg) => logger.info(msg)
    });
    if (migrations.length === 0) {
        logger.info('Database schema is up to date');
    } else {
        logger.info(`Applied ${migrations.length} migration(s): ${migrations.map((m) => m.name).join(', ')}`);
    }
    return migrations;
}

// Graceful pool shutdown — call from the server on SIGTERM/SIGINT.
async function shutdown() {
    try {
        await pool.end();
    } catch (err) {
        logger.error('Error closing PostgreSQL pool:', err.message);
    }
}

module.exports = {
    pool,
    query,
    withId,
    withTransaction,
    waitForConnection,
    runMigrations,
    shutdown
};
