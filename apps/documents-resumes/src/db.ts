import { Pool, type QueryResult, type QueryResultRow } from 'pg';

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
