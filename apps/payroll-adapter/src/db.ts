import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

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

/** Run `fn(client)` inside a transaction (same helper as hr-core). */
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

export interface AuditEntry {
    /** 'user:<id>' for gateway users, 'service' for trusted internal callers. */
    actor: string;
    action: string;
    entity: string;
    entityId?: string | number | null;
    metadata?: Record<string, unknown>;
}

/**
 * Append a payroll_audit row. Every mutation AND every fiscal-table access is
 * audited — this is the compliance trail for sensitive payroll data. Accepts
 * a Pool or a transaction client.
 */
export async function writeAudit(db: Pick<Pool, 'query'> | PoolClient, entry: AuditEntry): Promise<void> {
    await db.query(
        `INSERT INTO payroll_audit (actor, action, entity, entity_id, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
            entry.actor,
            entry.action,
            entry.entity,
            entry.entityId != null ? String(entry.entityId) : null,
            JSON.stringify(entry.metadata ?? {})
        ]
    );
}
