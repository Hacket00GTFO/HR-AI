import { Router, type Response } from 'express';
import { logger } from '@strafor/node-common';
import type { RouteDeps } from './auth.js';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth.js';
import { query } from '../db.js';

/**
 * Metadata keys that are safe to expose on the admin audit surface — entity
 * ids, titles, statuses, action counters. Anything else (notes, emails,
 * error messages, detail blobs, free text) is dropped before the row leaves
 * the service. What the writers actually record today: title, department,
 * status/to_status, role, source, changedKeys, fields, *_id refs, template.
 */
const SAFE_METADATA_KEYS = new Set([
    'title',
    'department',
    'status',
    'to_status',
    'type',
    'count',
    'role',
    'source',
    'changedKeys',
    'fields',
    'entityId',
    'entity_id',
    'candidate_id',
    'vacancy_id',
    'notificationId',
    'template'
]);

// Defense in depth on top of the key allowlist: even a whitelisted key is
// dropped when its value looks like an email address.
const EMAIL_LIKE = /\S+@\S+/;

function sanitizeMetadata(meta: Record<string, unknown> | null): Record<string, unknown> {
    if (meta == null || typeof meta !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
        if (!SAFE_METADATA_KEYS.has(k)) continue;
        if (typeof v === 'string' && EMAIL_LIKE.test(v)) continue;
        out[k] = v;
    }
    return out;
}

export function auditRouter(deps: RouteDeps): Router {
    const router = Router();

    // ---- GET /v1/audit (admin) — recent audit trail with filters ----
    // Returns the most recent audit rows. Supports filtering by actor, action,
    // entity, date range, and pagination via offset/limit.
    router.get('/', requireAdmin(deps), async (req: AuthenticatedRequest, res: Response) => {
        try {
            const rawLimit = Number(req.query['limit']);
            const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 10000) : 50;
            const rawOffset = Number(req.query['offset']);
            const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

            const conditions: string[] = [];
            const params: unknown[] = [];
            let paramIdx = 1;

            const actor = req.query['actor'];
            if (typeof actor === 'string' && actor) {
                conditions.push(`u.email ILIKE $${paramIdx}`);
                params.push(`%${actor}%`);
                paramIdx++;
            }

            const action = req.query['action'];
            if (typeof action === 'string' && action) {
                conditions.push(`a.action = $${paramIdx}`);
                params.push(action);
                paramIdx++;
            }

            const entity = req.query['entity'];
            if (typeof entity === 'string' && entity) {
                conditions.push(`a.entity = $${paramIdx}`);
                params.push(entity);
                paramIdx++;
            }

            const from = req.query['from'];
            if (typeof from === 'string' && from) {
                conditions.push(`a.created_at >= $${paramIdx}`);
                params.push(from);
                paramIdx++;
            }

            const to = req.query['to'];
            if (typeof to === 'string' && to) {
                conditions.push(`a.created_at <= $${paramIdx}`);
                params.push(to);
                paramIdx++;
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            const { rows } = await query<{
                id: string;
                action: string;
                entity: string;
                entity_id: number | null;
                metadata: Record<string, unknown>;
                created_at: Date;
                actor_id: number | null;
                actor_role: string | null;
            }>(
                `SELECT a.id, a.action, a.entity, a.entity_id, a.metadata, a.created_at,
                        a.actor_user_id AS actor_id,
                        u.role AS actor_role
                 FROM audit_logs a
                 LEFT JOIN users u ON u.id = a.actor_user_id
                 ${whereClause}
                 ORDER BY a.created_at DESC
                 LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
                [...params, limit, offset]
            );

            res.json(
                rows.map((r) => ({
                    id: r.id,
                    action: r.action,
                    entity: r.entity,
                    entityId: r.entity_id,
                    metadata: sanitizeMetadata(r.metadata),
                    actorId: r.actor_id,
                    actorRole: r.actor_role,
                    timestamp: r.created_at
                }))
            );
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'list audit error');
            res.status(500).json({ error: 'Error fetching audit trail' });
        }
    });

    return router;
}
