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
// Local event contracts — hr-services does not edit packages/contracts, so
// the envelope + payload schemas for the strafor.services.* events live here.
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

const TICKET_STATUSES = ['new', 'assigned', 'in_progress', 'waiting_employee', 'resolved', 'closed'] as const;
const EXPENSE_DECISIONS = ['approved', 'rejected'] as const;

// POST /v1/tickets created a service-desk ticket.
export const TicketCreated = eventEnvelope(
    'strafor.services.ticket_created',
    1,
    z
        .object({
            ticketId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            category: z.string().min(1),
            priority: z.enum(['critical', 'high', 'normal', 'low']),
            status: z.enum(TICKET_STATUSES),
            slaDueAt: z.string().optional()
        })
        .strict()
);

// POST /v1/tickets/:id/assign set (or changed) the assignee.
export const TicketAssigned = eventEnvelope(
    'strafor.services.ticket_assigned',
    1,
    z
        .object({
            ticketId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            assigneeUserId: z.number().int().positive(),
            status: z.enum(TICKET_STATUSES)
        })
        .strict()
);

// A ticket transitioned to resolved.
export const TicketResolved = eventEnvelope(
    'strafor.services.ticket_resolved',
    1,
    z
        .object({
            ticketId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            resolvedBy: z.number().int().positive().nullable().optional(),
            status: z.literal('resolved')
        })
        .strict()
);

// POST /v1/assets/:id/checkout assigned an asset to an employee.
export const AssetAssigned = eventEnvelope(
    'strafor.services.asset_assigned',
    1,
    z
        .object({
            assetId: z.number().int().positive(),
            assetTag: z.string().min(1),
            employeeId: z.number().int().positive(),
            assignmentId: z.number().int().positive()
        })
        .strict()
);

// POST /v1/assets/:id/checkin closed the open assignment.
export const AssetReturned = eventEnvelope(
    'strafor.services.asset_returned',
    1,
    z
        .object({
            assetId: z.number().int().positive(),
            assetTag: z.string().min(1),
            employeeId: z.number().int().positive(),
            assignmentId: z.number().int().positive(),
            assetStatus: z.enum(['available', 'maintenance'])
        })
        .strict()
);

// An employee submitted an expense report for approval.
export const ExpenseSubmitted = eventEnvelope(
    'strafor.services.expense_submitted',
    1,
    z
        .object({
            reportId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            total: z.number().nonnegative(),
            currency: z.string().length(3)
        })
        .strict()
);

// HR approved/rejected a submitted expense report.
export const ExpenseDecided = eventEnvelope(
    'strafor.services.expense_decided',
    1,
    z
        .object({
            reportId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            decision: z.enum(EXPENSE_DECISIONS),
            approverUserId: z.number().int().positive().nullable().optional(),
            total: z.number().nonnegative(),
            currency: z.string().length(3)
        })
        .strict()
);

// A survey moved draft → open.
export const SurveyOpened = eventEnvelope(
    'strafor.services.survey_opened',
    1,
    z
        .object({
            surveyId: z.number().int().positive(),
            type: z.enum(['nom035', 'climate']),
            opensAt: z.string().nullable().optional(),
            closesAt: z.string().nullable().optional()
        })
        .strict()
);

// A survey moved open → closed (aggregates computed).
export const SurveyClosed = eventEnvelope(
    'strafor.services.survey_closed',
    1,
    z
        .object({
            surveyId: z.number().int().positive(),
            type: z.enum(['nom035', 'climate']),
            respondents: z.number().int().nonnegative()
        })
        .strict()
);

/** Type → envelope schema, used by the outbox sweeper to validate payloads. */
export const EVENT_TYPES: Record<string, z.ZodTypeAny> = {
    'strafor.services.ticket_created': TicketCreated,
    'strafor.services.ticket_assigned': TicketAssigned,
    'strafor.services.ticket_resolved': TicketResolved,
    'strafor.services.asset_assigned': AssetAssigned,
    'strafor.services.asset_returned': AssetReturned,
    'strafor.services.expense_submitted': ExpenseSubmitted,
    'strafor.services.expense_decided': ExpenseDecided,
    'strafor.services.survey_opened': SurveyOpened,
    'strafor.services.survey_closed': SurveyClosed
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Best-effort domain-event publisher on the `domain.events` topic exchange.
 * Broker absence is tolerated: connect/publish failures are logged and
 * swallowed so HR-service workflows never block on RabbitMQ — events sit in
 * the outbox_events table until the sweeper can deliver them.
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
            // ids are free-form, so fall back to a fresh one rather than
            // failing contract validation.
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
 * no registered schema are dropped with an error log — that is a build-time
 * bug, retrying would poison the queue forever.
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
