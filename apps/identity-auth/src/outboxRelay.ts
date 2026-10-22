import amqp from 'amqplib';
import type { Pool, PoolClient } from 'pg';
import { logger } from '@strafor/node-common';
import { getPool } from './db.js';
import type { ServiceConfig } from './config.js';

/**
 * Outbox relay — drains outbox_events to RabbitMQ.
 *
 * Polls every `intervalMs` (~2s), claims a batch of due pending rows with
 * SELECT ... FOR UPDATE SKIP LOCKED inside a transaction, publishes each to
 * the `domain.events` topic exchange (routing key = event_type) on a confirm
 * channel, then marks them sent in the same tx. A crash between publish and
 * commit leaves the row pending → at-least-once delivery; consumers dedupe
 * on the envelope's correlationId (a uuid minted per row by
 * outbox.recordOutboxEvent). Ported from apps/api/utils/outboxRelay.js.
 *
 * Publish failures increment `attempts` and reschedule with quadratic
 * backoff (attempts^2 * intervalMs, capped at maxBackoffMs); a row is marked
 * 'failed' once it reaches maxAttempts. Broker unavailability never crashes
 * the service: getChannel() returns null and the next tick retries.
 *
 * Started from server.ts after migrations; stopped on SIGTERM/SIGINT.
 */

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type ConfirmChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

interface OutboxRow {
    id: string;
    event_type: string;
    payload: { correlationId?: string } & Record<string, unknown>;
    attempts: number;
}

interface MinimalLogger {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
}

export interface RelayOptions {
    /** RABBITMQ_URL — relay disabled when unset. */
    url?: string | undefined;
    /** RABBITMQ_EXCHANGE (default 'domain.events'). */
    exchange?: string;
    intervalMs?: number;
    batchSize?: number;
    maxAttempts?: number;
    /** pg Pool — injectable for tests; defaults to the app pool. */
    pool?: Pool;
    log?: MinimalLogger;
    /** amqp connect override — injectable for tests. */
    connect?: (url: string) => Promise<AmqpConnection>;
}

export interface Relay {
    start(): void;
    stop(): Promise<void>;
    /** One poll iteration — exposed so tests can drive it without timers. */
    tick(): Promise<void>;
}

export function createRelay({
    url = process.env.RABBITMQ_URL,
    exchange = process.env.RABBITMQ_EXCHANGE || 'domain.events',
    intervalMs = DEFAULT_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    pool,
    log = logger,
    connect
}: RelayOptions = {}): Relay {
    const amqpConnect = connect || ((u: string) => amqp.connect(u));

    let conn: AmqpConnection | null = null;
    let channel: ConfirmChannel | null = null;
    let connecting: Promise<ConfirmChannel | null> | null = null;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let inFlight: Promise<void> | null = null;

    // Lazy connect with in-flight dedupe. Returns null while the broker is
    // unreachable — callers just skip the tick and retry on the next one.
    async function getChannel(): Promise<ConfirmChannel | null> {
        if (channel) return channel;
        if (!url || stopped) return null;
        if (!connecting) {
            connecting = (async () => {
                try {
                    const connection = await amqpConnect(url);
                    conn = connection;
                    if (typeof connection.on === 'function') {
                        connection.on('error', (err: Error) =>
                            log.warn({ err: err instanceof Error ? err.message : err }, 'outbox relay amqp error')
                        );
                        connection.on('close', () => {
                            channel = null;
                            conn = null;
                        });
                    }
                    const ch = await connection.createConfirmChannel();
                    await ch.assertExchange(exchange, 'topic', { durable: true });
                    channel = ch;
                    log.info({ exchange }, 'outbox relay connected to RabbitMQ');
                    return ch;
                } catch (err) {
                    log.warn(
                        { err: err instanceof Error ? err.message : err },
                        'outbox relay: RabbitMQ unavailable — retrying next tick'
                    );
                    return null;
                }
            })().finally(() => {
                connecting = null;
            });
        }
        return connecting;
    }

    async function markSent(client: PoolClient, id: string): Promise<void> {
        await client.query("UPDATE outbox_events SET status = 'sent', sent_at = now() WHERE id = $1", [id]);
    }

    async function markAttemptFailed(client: PoolClient, row: OutboxRow, err: unknown): Promise<void> {
        const attempts = row.attempts + 1;
        if (attempts >= maxAttempts) {
            await client.query('UPDATE outbox_events SET status = $2, attempts = $3 WHERE id = $1', [
                row.id,
                'failed',
                attempts
            ]);
            log.error(
                { id: row.id, eventType: row.event_type, attempts },
                'outbox event exhausted retries — marked failed'
            );
            return;
        }
        const backoffMs = Math.min(attempts * attempts * intervalMs, MAX_BACKOFF_MS);
        await client.query('UPDATE outbox_events SET attempts = $2, next_attempt_at = $3 WHERE id = $1', [
            row.id,
            attempts,
            new Date(Date.now() + backoffMs)
        ]);
        log.warn(
            {
                id: row.id,
                eventType: row.event_type,
                attempts,
                backoffMs,
                err: err instanceof Error ? err.message : err
            },
            'outbox event publish failed — rescheduled'
        );
    }

    async function tick(): Promise<void> {
        if (stopped) return;
        const ch = await getChannel();
        if (!ch) return;

        const activePool = pool ?? getPool();
        const client = await activePool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query<OutboxRow>(
                `SELECT id, event_type, payload, attempts
                 FROM outbox_events
                 WHERE status = 'pending' AND next_attempt_at <= now()
                 ORDER BY id
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED`,
                [batchSize]
            );

            for (const row of rows) {
                try {
                    const body = Buffer.from(JSON.stringify(row.payload));
                    ch.publish(exchange, row.event_type, body, {
                        persistent: true,
                        contentType: 'application/json',
                        // Stable event id for consumer-side dedupe.
                        messageId: row.payload?.correlationId,
                        headers: { 'x-event-id': row.payload?.correlationId }
                    });
                    await ch.waitForConfirms();
                    await markSent(client, row.id);
                } catch (err) {
                    // Keep draining the rest of the batch — a poisoned event
                    // must not starve the rows behind it.
                    await markAttemptFailed(client, row, err);
                }
            }

            await client.query('COMMIT');
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch {
                /* already rolled back */
            }
            log.warn(
                { err: err instanceof Error ? err.message : err },
                'outbox relay tick failed — will retry next interval'
            );
        } finally {
            client.release();
        }
    }

    function schedule(): void {
        if (stopped) return;
        timer = setTimeout(run, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    async function run(): Promise<void> {
        inFlight = tick();
        try {
            await inFlight;
        } finally {
            inFlight = null;
            schedule();
        }
    }

    function start(): void {
        if (stopped) return;
        if (!url) {
            log.info('RABBITMQ_URL unset — outbox relay disabled (events stay pending in outbox_events)');
            return;
        }
        log.info({ exchange, intervalMs }, 'outbox relay started');
        schedule();
    }

    async function stop(): Promise<void> {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (inFlight) {
            try {
                await inFlight;
            } catch {
                /* tick swallows its own errors */
            }
        }
        try {
            await channel?.close();
        } catch {
            /* best effort */
        }
        try {
            await conn?.close();
        } catch {
            /* best effort */
        }
        channel = null;
        conn = null;
    }

    return { start, stop, tick };
}

/** Relay bound to the service config — server.ts boots this. */
export function createServiceRelay(config: ServiceConfig): Relay {
    return createRelay({ url: config.rabbitmqUrl });
}
