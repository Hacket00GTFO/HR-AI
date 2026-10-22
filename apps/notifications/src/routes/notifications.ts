import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import { requireUser, serviceOrAdminAuth, serviceOrUserAuth } from '../auth.js';
import { queueNotification } from '../notifyService.js';

export interface NotificationsDeps {
    pool: Pool;
    config: ServiceConfig;
    log: ServiceLogger;
}

const sendSchema = z.object({
    to: z.string().email().max(320),
    template: z.string().min(1).max(120),
    payload: z.record(z.string(), z.unknown()).default({}),
    locale: z.enum(['en', 'es']).default('en'),
    userId: z.number().int().positive().nullish()
});

const listQuerySchema = z.object({
    status: z.enum(['queued', 'sent', 'failed', 'suppressed']).optional(),
    template: z.string().trim().min(1).max(120).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20)
});

const prefsSchema = z.object({
    email: z.boolean()
});

function rowToLog(row: Record<string, unknown>) {
    return {
        id: row.id,
        toEmail: row.to_email,
        templateKey: row.template_key,
        locale: row.locale,
        payload: row.payload,
        status: row.status,
        error: row.error ?? null,
        attempts: row.attempts,
        sentAt: row.sent_at ?? null,
        correlationId: row.correlation_id ?? null,
        userId: row.user_id ?? null,
        createdAt: row.created_at
    };
}

export function notificationsRouter(deps: NotificationsDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    // POST /v1/notifications/send — service or user auth, idempotent.
    router.post('/send', serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), async (req, res, next) => {
        try {
            const idemKey = req.get('Idempotency-Key');
            if (!idemKey || idemKey.length < 8 || idemKey.length > 200) {
                throw httpError(400, 'Idempotency-Key header required (8–200 chars)');
            }
            const body = sendSchema.safeParse(req.body);
            if (!body.success) {
                throw httpError(400, 'Invalid request body', body.error.issues);
            }
            const result = await queueNotification(pool, {
                to: body.data.to,
                template: body.data.template,
                payload: body.data.payload,
                locale: body.data.locale,
                userId: body.data.userId ?? null,
                idempotencyKey: idemKey,
                correlationId: req.correlationId ?? null
            });
            res.status(202).json(result);
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/notifications — admin (or trusted service) paginated log list.
    router.get('/', serviceOrAdminAuth(config.SERVICE_AUTH_TOKEN), async (req, res, next) => {
        try {
            const q = listQuerySchema.safeParse(req.query);
            if (!q.success) {
                throw httpError(400, 'Invalid query parameters', q.error.issues);
            }
            const { status, template, from, to, page, pageSize } = q.data;
            const conditions: string[] = [];
            const params: unknown[] = [];
            if (status) {
                params.push(status);
                conditions.push(`status = $${params.length}`);
            }
            if (template) {
                params.push(template);
                conditions.push(`template_key = $${params.length}`);
            }
            if (from) {
                params.push(from);
                conditions.push(`created_at >= $${params.length}`);
            }
            if (to) {
                params.push(to);
                conditions.push(`created_at <= $${params.length}`);
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

            const total = await pool.query(`SELECT count(*)::int AS n FROM notification_logs ${where}`, params);
            const { rows } = await pool.query(
                `SELECT * FROM notification_logs ${where}
                  ORDER BY created_at DESC
                  LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                [...params, pageSize, (page - 1) * pageSize]
            );
            res.json({
                items: rows.map(rowToLog),
                page,
                pageSize,
                total: total.rows[0]?.n ?? 0
            });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/notifications/stats — aggregate counts by status + template.
    router.get('/stats', serviceOrAdminAuth(config.SERVICE_AUTH_TOKEN), async (_req, res, next) => {
        try {
            const { rows: byStatusRows } = await pool.query(
                `SELECT status, COUNT(*)::int AS n FROM notification_logs GROUP BY status`
            );
            const byStatus: Record<string, number> = {};
            let total = 0;
            for (const r of byStatusRows) {
                byStatus[r.status as string] = r.n;
                total += r.n;
            }
            const sent = byStatus.sent ?? 0;
            const failed = byStatus.failed ?? 0;
            const attempted = sent + failed;
            const { rows: byTemplate } = await pool.query(
                `SELECT template_key AS template, COUNT(*)::int AS n
                   FROM notification_logs GROUP BY template_key ORDER BY n DESC`
            );
            res.json({
                total,
                by_status: byStatus,
                by_template: byTemplate,
                total_sent: sent,
                total_failed: failed,
                success_rate: attempted > 0 ? (sent / attempted) * 100 : 0
            });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/notifications/templates — template catalogue (key/locale/subject).
    router.get('/templates', serviceOrAdminAuth(config.SERVICE_AUTH_TOKEN), async (_req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT key, locale, subject, created_at
                   FROM notification_templates ORDER BY key, locale`
            );
            res.json(rows);
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/notifications/:id/retry — requeue a permanently-failed log row.
    // Guarded by the status predicate: only 'failed' rows transition, anything
    // else is a 409 (or 404 when the id doesn't exist).
    router.post('/:id/retry', serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `UPDATE notification_logs
                    SET status = 'queued', error = NULL, next_attempt_at = NULL, sent_at = NULL
                  WHERE id = $1 AND status = 'failed'
                  RETURNING *`,
                [req.params.id]
            );
            if (!rows[0]) {
                const existing = await pool.query(`SELECT status FROM notification_logs WHERE id = $1`, [
                    req.params.id
                ]);
                if (!existing.rows[0]) throw httpError(404, 'Notification not found');
                throw httpError(409, `Cannot retry notification in status '${existing.rows[0].status}'`);
            }
            res.json(rowToLog(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/notifications/preferences — caller's own prefs (default allow).
    router.get('/preferences', requireUser, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT channel, enabled, updated_at FROM notification_preferences
                  WHERE user_id = $1`,
                [req.user?.userId]
            );
            const email = rows.find((r) => r.channel === 'email');
            res.json({
                userId: req.user?.userId,
                channels: { email: email ? email.enabled : true },
                updatedAt: email?.updated_at ?? null
            });
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/notifications/preferences — upsert caller's email channel pref.
    router.put('/preferences', requireUser, async (req, res, next) => {
        try {
            const body = prefsSchema.safeParse(req.body);
            if (!body.success) {
                throw httpError(400, 'Invalid request body', body.error.issues);
            }
            const userId = req.user?.userId;
            const { rows } = await pool.query(
                `INSERT INTO notification_preferences (user_id, channel, enabled, updated_at)
                 VALUES ($1, 'email', $2, now())
                 ON CONFLICT (user_id, channel)
                 DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
                 RETURNING enabled, updated_at`,
                [userId, body.data.email]
            );
            res.json({
                userId,
                channels: { email: rows[0].enabled },
                updatedAt: rows[0].updated_at
            });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
