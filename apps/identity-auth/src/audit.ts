import type { PoolClient } from 'pg';
import { query } from './db.js';
import { logger } from '@strafor/node-common';

export interface AuditEntry {
    actorId?: number | string | null;
    action: string;
    entity: string;
    entityId?: number | string | null;
    metadata?: Record<string, unknown>;
    client?: PoolClient;
}

/** Append one row to audit_logs. Best-effort — never fails the request. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
    try {
        const q = entry.client ?? { query: (t: string, p: unknown[]) => query(t, p) };
        await q.query(
            `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                entry.actorId != null ? Number(entry.actorId) : null,
                entry.action,
                entry.entity,
                entry.entityId != null ? Number(entry.entityId) : null,
                JSON.stringify(entry.metadata ?? {})
            ]
        );
    } catch (err) {
        logger.error(
            { err: (err as Error).message, action: entry.action, entity: entry.entity },
            'audit_logs write failed'
        );
    }
}
