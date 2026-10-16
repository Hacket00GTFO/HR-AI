import { randomUUID } from 'node:crypto';
import amqplib, { type Channel, type ChannelModel } from 'amqplib';
import { logger as rootLogger, type ServiceLogger } from '@strafor/node-common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Queryable } from './db.js';

export interface EventEnvelope {
    type: string;
    version: number;
    occurredAt: string;
    correlationId: string;
    payload: Record<string, unknown>;
}

export interface EventPublisher {
    publish(
        schema: z.ZodTypeAny,
        type: string,
        payload: Record<string, unknown>,
        correlationId?: string
    ): Promise<boolean>;
    close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local event contracts — hr-core owns the strafor.hr.* payloads that are
// not part of packages/contracts (the workflow events added in 0002).
// Envelope mirrors packages/contracts/events/base.js.
// ---------------------------------------------------------------------------

const eventEnvelope = (type: string, version: number, payloadSchema: z.ZodTypeAny) =>
    z
        .object({
            type: z.literal(type),
            version: z.literal(version),
            occurredAt: z.iso.datetime({ offset: true }),
            correlationId: z.uuid(),
            payload: payloadSchema
        })
        .strict();

const WORKFLOW_KINDS = ['onboarding', 'offboarding'] as const;

// POST /v1/employees/:id/workflows instantiated a workflow from a template.
export const WorkflowStarted = eventEnvelope(
    'strafor.hr.workflow_started',
    1,
    z
        .object({
            workflowId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            kind: z.enum(WORKFLOW_KINDS),
            templateId: z.number().int().positive().nullable().optional(),
            taskCount: z.number().int().nonnegative()
        })
        .strict()
);

// POST /v1/workflow-tasks/:id/complete marked a task done.
export const WorkflowTaskCompleted = eventEnvelope(
    'strafor.hr.workflow_task_completed',
    1,
    z
        .object({
            workflowId: z.number().int().positive(),
            taskId: z.number().int().positive(),
            department: z.string().min(1),
            title: z.string().min(1),
            completedBy: z.number().int().positive().nullable().optional()
        })
        .strict()
);

// The last required task finished — the workflow auto-completed.
export const WorkflowCompleted = eventEnvelope(
    'strafor.hr.workflow_completed',
    1,
    z
        .object({
            workflowId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            kind: z.enum(WORKFLOW_KINDS)
        })
        .strict()
);

/** Type → envelope schema, used by the outbox sweeper to validate payloads. */
export const EVENT_TYPES: Record<string, z.ZodTypeAny> = {
    'strafor.hr.workflow_started': WorkflowStarted,
    'strafor.hr.workflow_task_completed': WorkflowTaskCompleted,
    'strafor.hr.workflow_completed': WorkflowCompleted
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Best-effort domain-event publisher on the `domain.events` topic exchange.
 * Broker absence is tolerated: connect/publish failures are logged and
 * swallowed so HR workflows never block on RabbitMQ — outboxed events sit
 * in the outbox_events table until the sweeper can deliver them.
 */
export function createPublisher(
    url: string | undefined,
    exchange: string,
    log: ServiceLogger = rootLogger
): EventPublisher {
    let conn: ChannelModel | null = null;
    let channel: Channel | null = null;
    let connecting: Promise<Channel | null> | null = null;

    async function getChannel(): Promise<Channel | null> {
        if (channel) return channel;
        if (!url) return null;
        if (!connecting) {
            connecting = (async () => {
                try {
                    conn = await amqplib.connect(url);
                    conn.on('close', () => {
                        channel = null;
                        conn = null;
                    });
                    conn.on('error', (err: Error) => log.warn({ err: err.message }, 'rabbitmq connection error'));
                    const ch = await conn.createConfirmChannel();
                    await ch.assertExchange(exchange, 'topic', { durable: true });
                    channel = ch;
                    log.info({ exchange }, 'rabbitmq publisher connected');
                    return ch;
                } catch (err) {
                    log.warn(
                        { err: err instanceof Error ? err.message : err },
                        'rabbitmq unavailable — events will be skipped'
                    );
                    return null;
                } finally {
                    connecting = null;
                }
            })();
        }
        return connecting;
    }

    return {
        async publish(schema, type, payload, correlationId) {
            // The envelope contract requires a UUID correlation id — inbound
            // ids are free-form (sanitized but not necessarily UUIDs), so fall
            // back to a fresh one rather than failing contract validation.
            const envelope: EventEnvelope = {
                type,
                version: 1,
                occurredAt: new Date().toISOString(),
                correlationId: correlationId && UUID_RE.test(correlationId) ? correlationId : randomUUID(),
                payload
            };
            const parsed = schema.safeParse(envelope);
            if (!parsed.success) {
                log.error({ type, issues: parsed.error.issues }, 'event failed contract validation — not published');
                return false;
            }
            const ch = await getChannel();
            if (!ch) return false;
            try {
                ch.publish(exchange, type, Buffer.from(JSON.stringify(envelope)), {
                    persistent: true,
                    contentType: 'application/json'
                });
                log.debug({ type, correlationId: envelope.correlationId }, 'event published');
                return true;
            } catch (err) {
                log.warn({ err: err instanceof Error ? err.message : err, type }, 'event publish failed');
                return false;
            }
        },
        async close() {
            try {
                await channel?.close();
            } catch {
                /* ignore */
            }
            try {
                await conn?.close();
            } catch {
                /* ignore */
            }
            channel = null;
            conn = null;
        }
    };
}

/**
 * Transactional outbox — insert the event row inside the business
 * transaction so a committed write can never lose its event. Post-commit,
 * call `flushOutbox` to deliver (the sweeper covers the rest).
 */
export async function enqueueEvent(
    client: Queryable,
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string
): Promise<void> {
    await client.query(`INSERT INTO outbox_events (type, payload, correlation_id) VALUES ($1, $2, $3)`, [
        type,
        JSON.stringify(payload),
        correlationId ?? null
    ]);
}

/**
 * Publish every unpublished outbox row (oldest first). Rows whose type has
 * no registered contract schema are dropped with an error log — that is a
 * build-time bug, retrying would poison the queue forever.
 * Returns the number of events successfully published.
 */
export async function flushOutbox(
    pool: Pool,
    publisher: EventPublisher,
    log: ServiceLogger = rootLogger,
    limit = 100
): Promise<number> {
    const { rows } = await pool.query(
        `SELECT id, type, payload, correlation_id
         FROM outbox_events WHERE published_at IS NULL
         ORDER BY id LIMIT $1`,
        [limit]
    );
    let published = 0;
    for (const row of rows) {
        const schema = EVENT_TYPES[row.type as string] as z.ZodTypeAny | undefined;
        if (!schema) {
            log.error({ id: row.id, type: row.type }, 'outbox event has no schema — dropping');
            await pool.query(`UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1`, [
                row.id
            ]);
            continue;
        }
        const ok = await publisher.publish(schema, row.type, row.payload, row.correlation_id ?? undefined);
        if (ok) {
            await pool.query(`UPDATE outbox_events SET published_at = now() WHERE id = $1`, [row.id]);
            published += 1;
        } else {
            await pool.query(`UPDATE outbox_events SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        }
    }
    return published;
}

export interface OutboxWorker {
    stop(): void;
}

/** Periodic sweeper — delivers events stranded by a broker outage/crash. */
export function startOutboxWorker(
    pool: Pool,
    publisher: EventPublisher,
    log: ServiceLogger,
    pollMs = 15000
): OutboxWorker {
    const timer = setInterval(() => {
        void flushOutbox(pool, publisher, log).catch((err) =>
            log.warn({ err: err instanceof Error ? err.message : err }, 'outbox sweep failed')
        );
    }, pollMs);
    timer.unref();
    return {
        stop() {
            clearInterval(timer);
        }
    };
}

/** No-op publisher for tests and for running without a broker. */
export const nullPublisher: EventPublisher = {
    publish: async () => true,
    close: async () => {}
};
