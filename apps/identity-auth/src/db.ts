import path from 'node:path';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { logger } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';

let pool: Pool | null = null;

export function initPool(config: ServiceConfig): Pool {
    if (pool) return pool;
    pool = new Pool({
        connectionString: config.databaseUrl,
        max: config.pgPoolMax,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: config.pgConnTimeoutMs,
        keepAlive: true,
        application_name: 'strafor-identity-auth'
    });
    pool.on('error', (err) => {
        logger.error({ err: err.message }, 'unexpected pg idle client error');
    });
    return pool;
}

export function getPool(): Pool {
    if (!pool) throw new Error('db pool not initialized — call initPool() first');
    return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
): Promise<QueryResult<T>> {
    return getPool().query<T>(text, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForConnection(): Promise<void> {
    let attempt = 0;
    for (;;) {
        try {
            await getPool().query('SELECT 1');
            logger.info('connected to PostgreSQL');
            return;
        } catch (err) {
            attempt += 1;
            const delay = Math.min(15000, 1000 * attempt);
            logger.error({ err: (err as Error).message }, 'postgres connection failed');
            logger.info(`retrying in ${delay / 1000}s (attempt ${attempt})`);
            await sleep(delay);
        }
    }
}

export async function runMigrations(databaseUrl?: string): Promise<void> {
    const url = databaseUrl || process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required to run migrations');
    const { runner } = await import('node-pg-migrate');
    const migrations = await runner({
        databaseUrl: url,
        dir: path.join(__dirname, '..', 'migrations'),
        direction: 'up',
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
        schema: 'public',
        verbose: false,
        log: (msg: string) => logger.info(msg)
    });
    if (migrations.length === 0) {
        logger.info('identity schema up to date');
    } else {
        logger.info(`applied ${migrations.length} migration(s): ${migrations.map((m) => m.name).join(', ')}`);
    }
}

export async function shutdownDb(): Promise<void> {
    if (pool) {
        const p = pool;
        pool = null;
        await p.end().catch((err) => logger.error({ err: (err as Error).message }, 'pg pool close failed'));
    }
}
