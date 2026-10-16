import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/** Minimal query surface shared by Pool and transaction Clients. */
export interface Queryable {
    query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export function createPool(connectionString: string): Pool {
    return new Pool({
        connectionString,
        max: Number(process.env.PG_POOL_MAX || 10),
        idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
        connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 5_000)
    });
}

export async function query<T extends QueryResultRow = QueryResultRow>(
    pool: Pool,
    text: string,
    params: unknown[] = []
): Promise<QueryResult<T>> {
    return pool.query<T>(text, params);
}

/** Run `fn(client)` inside a transaction (ported from the monolith db helper). */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

/**
 * Map a DB row to the API shape (adds _id for compatibility with the legacy
 * frontend, which still keys on MongoDB-style ids).
 */
export function withId<T extends { id?: unknown }>(row: T | null | undefined): T | null | undefined {
    if (row) {
        (row as Record<string, unknown>)._id = String(row.id);
    }
    return row;
}
