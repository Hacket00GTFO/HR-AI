import type { Pool } from 'pg';
import { httpError } from '@strafor/node-common';
import type { TemplatePayload } from './render.js';

export interface QueueInput {
    to: string;
    template: string;
    payload: TemplatePayload;
    locale: string;
    idempotencyKey: string;
    userId?: number | null;
    correlationId?: string | null;
}

export interface QueueResult {
    id: string;
    status: 'queued' | 'suppressed' | 'sent' | 'failed';
    replayed: boolean;
}

/**
 * Payload keys that carry bearer credentials in transit (e.g. the
 * password-reset URL). Templates need them at render time, so they persist
 * while a row is queued/retrying — but they are scrubbed once the row can no
 * longer be delivered: stripped at insert for 'suppressed' rows (never
 * rendered), and removed by the worker when a row reaches 'sent' or
 * permanently 'failed'.
 */
export const SENSITIVE_PAYLOAD_KEYS = ['resetUrl', 'resetLink'];

function stripSensitiveKeys(payload: TemplatePayload): TemplatePayload {
    const out = { ...(payload ?? {}) };
    for (const k of SENSITIVE_PAYLOAD_KEYS) delete out[k];
    return out;
}

/**
 * Idempotent enqueue shared by POST /v1/notifications/send and the
 * domain-event consumer.
 *
 *  - template must exist for (key, locale), falling back to 'en'
 *  - per-user preference suppression wins (default: allowed)
 *  - idempotency_key conflict → returns the original row (replay-safe)
 */
export async function queueNotification(pool: Pool, input: QueueInput): Promise<QueueResult> {
    const { rows: templates } = await pool.query(
        `SELECT id FROM notification_templates
          WHERE key = $1 AND locale IN ($2, 'en')
          ORDER BY (locale = $2) DESC
          LIMIT 1`,
        [input.template, input.locale]
    );
    if (!templates[0]) {
        throw httpError(404, `Template not found: ${input.template} (${input.locale})`);
    }

    let suppressed = false;
    if (input.userId != null) {
        const pref = await pool.query(
            `SELECT enabled FROM notification_preferences
              WHERE user_id = $1 AND channel = 'email'`,
            [input.userId]
        );
        if (pref.rows[0] && pref.rows[0].enabled === false) suppressed = true;
    }

    const status = suppressed ? 'suppressed' : 'queued';
    const inserted = await pool.query(
        `INSERT INTO notification_logs
            (idempotency_key, to_email, template_key, locale, payload, status,
             correlation_id, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, status`,
        [
            input.idempotencyKey,
            input.to,
            input.template,
            input.locale,
            // Suppressed rows are never rendered — no reason to keep
            // credential-bearing payload keys at rest on them.
            JSON.stringify(suppressed ? stripSensitiveKeys(input.payload) : (input.payload ?? {})),
            status,
            input.correlationId ?? null,
            input.userId ?? null
        ]
    );

    if (inserted.rows[0]) {
        return { id: inserted.rows[0].id, status: inserted.rows[0].status, replayed: false };
    }

    // Replay — return the original row untouched.
    const existing = await pool.query(`SELECT id, status FROM notification_logs WHERE idempotency_key = $1`, [
        input.idempotencyKey
    ]);
    if (!existing.rows[0]) {
        throw new Error('idempotency conflict but original row missing');
    }
    return { id: existing.rows[0].id, status: existing.rows[0].status, replayed: true };
}
