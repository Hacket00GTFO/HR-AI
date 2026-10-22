import type { Pool } from 'pg';
import type { Transporter } from 'nodemailer';
import { NotificationFailed, NotificationSent } from '@strafor/contracts';
import type { ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';
import type { EventPublisher } from './events.js';
import { sendMail } from './mailer.js';
import { renderTemplate } from './render.js';
import { SENSITIVE_PAYLOAD_KEYS } from './notifyService.js';

interface LogRow {
    id: string;
    to_email: string;
    template_key: string;
    locale: string;
    payload: Record<string, unknown>;
    attempts: number;
    correlation_id: string | null;
}

// SENSITIVE_PAYLOAD_KEYS (notifyService.ts) are credential-bearing payload
// keys — needed at render time, scrubbed from the stored row when it reaches
// a terminal state ('sent', or 'failed' with retries exhausted). Note: a
// retried row that was already scrubbed renders without the credential —
// acceptable, since reset tokens expire quickly.

export interface WorkerDeps {
    pool: Pool;
    transporter: Transporter;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

/** Claim one due queued log row (attempts incremented at claim time). */
async function claim(pool: Pool): Promise<LogRow | null> {
    const { rows } = await pool.query<LogRow>(
        `UPDATE notification_logs
            SET attempts = attempts + 1
          WHERE id = (
              SELECT id FROM notification_logs
               WHERE status = 'queued'
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
               ORDER BY created_at
               FOR UPDATE SKIP LOCKED
               LIMIT 1
          )
          RETURNING id, to_email, template_key, locale, payload, attempts, correlation_id`
    );
    return rows[0] ?? null;
}

async function deliver(deps: WorkerDeps, row: LogRow): Promise<void> {
    const { pool, transporter, config, publisher, log } = deps;

    const { rows: templates } = await pool.query(
        `SELECT subject, body_text, body_html FROM notification_templates
          WHERE key = $1 AND locale IN ($2, 'en')
          ORDER BY (locale = $2) DESC
          LIMIT 1`,
        [row.template_key, row.locale]
    );
    const template = templates[0];
    if (!template) throw new Error(`template vanished: ${row.template_key}`);

    const subject = renderTemplate(template.subject, row.payload);
    const text = renderTemplate(template.body_text, row.payload);
    const html = template.body_html ? renderTemplate(template.body_html, row.payload, true) : undefined;

    await sendMail(transporter, config.SMTP_FROM, {
        to: row.to_email,
        subject,
        text,
        ...(html !== undefined ? { html } : {})
    });

    // Mark sent AND scrub credential-bearing payload keys in one statement —
    // the email is already rendered, the URL must not stay in the log row.
    await pool.query(
        `UPDATE notification_logs
            SET status = 'sent', sent_at = now(), error = NULL,
                payload = payload - $2::text[]
          WHERE id = $1`,
        [row.id, SENSITIVE_PAYLOAD_KEYS]
    );
    await publisher.publish(
        NotificationSent,
        'strafor.notification.sent',
        {
            notificationId: row.id,
            channel: 'email',
            recipient: row.to_email,
            template: row.template_key,
            sentAt: new Date().toISOString()
        },
        row.correlation_id ?? undefined
    );
    log.info({ id: row.id, to: row.to_email, template: row.template_key }, 'notification sent');
}

/**
 * Claim + send the next due notification. Returns true when one was
 * processed — exported for deterministic tests.
 */
export async function processNextNotification(deps: WorkerDeps): Promise<boolean> {
    const { pool, config, publisher, log } = deps;
    const row = await claim(pool);
    if (!row) return false;
    try {
        await deliver(deps, row);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (row.attempts >= config.MAX_ATTEMPTS) {
            // DLQ state: failed, no further retries. Scrub credential-bearing
            // payload keys too — a dead row must not keep a live reset URL.
            await pool.query(
                `UPDATE notification_logs
                    SET status = 'failed', error = $2, next_attempt_at = NULL,
                        payload = payload - $3::text[]
                  WHERE id = $1`,
                [row.id, message, SENSITIVE_PAYLOAD_KEYS]
            );
            await publisher.publish(
                NotificationFailed,
                'strafor.notification.failed',
                {
                    notificationId: row.id,
                    channel: 'email',
                    recipient: row.to_email,
                    template: row.template_key,
                    reason: message,
                    retryable: false
                },
                row.correlation_id ?? undefined
            );
            log.error({ id: row.id, attempts: row.attempts, err: message }, 'notification failed permanently');
        } else {
            const delayMs = config.RETRY_BASE_MS * 2 ** (row.attempts - 1);
            await pool.query(
                `UPDATE notification_logs
                    SET error = $2, next_attempt_at = now() + ($3 || ' milliseconds')::interval
                  WHERE id = $1`,
                [row.id, message, String(delayMs)]
            );
            log.warn(
                { id: row.id, attempts: row.attempts, retryInMs: delayMs, err: message },
                'notification send failed — will retry'
            );
        }
    }
    return true;
}

export function startWorker(deps: WorkerDeps): { stop: () => void } {
    const { config, log } = deps;
    let running = true;
    let busy = false;

    const tick = async () => {
        if (!running || busy) return;
        busy = true;
        try {
            while (await processNextNotification(deps)) {
                /* drain queue */
            }
        } catch (err) {
            log.error({ err: err instanceof Error ? err.message : err }, 'send worker tick failed');
        } finally {
            busy = false;
        }
    };

    const timer = setInterval(() => void tick(), config.WORKER_POLL_MS);
    timer.unref();
    return {
        stop() {
            running = false;
            clearInterval(timer);
        }
    };
}
