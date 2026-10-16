// Outbox relay — drains outbox_events to RabbitMQ.
//
// Polls every `intervalMs` (~2s), claims a batch of due pending rows with
// SELECT ... FOR UPDATE SKIP LOCKED inside a transaction, publishes each to
// the `domain.events` topic exchange (routing key = event_type) on a confirm
// channel, then marks them sent in the same tx. A crash between publish and
// commit leaves the row pending → at-least-once delivery; consumers dedupe
// on the envelope's correlationId (a uuid minted per row by outbox.record).
//
// Publish failures increment `attempts` and reschedule with quadratic
// backoff (attempts^2 * intervalMs, capped at maxBackoffMs); a row is marked
// 'failed' once it reaches maxAttempts. Broker unavailability never crashes
// the API: getChannel() returns null and the next tick retries the connect.
//
// Started from server.js after migrations; stopped on SIGTERM/SIGINT.

const amqplib = require('amqplib');
const db = require('../db');
const logger = require('./logger');

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} [opts.url]        RABBITMQ_URL (relay disabled when unset)
 * @param {string} [opts.exchange]   RABBITMQ_EXCHANGE (default 'domain.events')
 * @param {object} [opts.pool]       pg Pool — injectable for tests
 * @param {Function} [opts.connect]  amqp connect override — injectable for tests
 * @param {object} [opts.log]        logger override — injectable for tests
 * @returns {{start(): void, stop(): Promise<void>, tick(): Promise<void>}}
 */
function createRelay({
    url = process.env.RABBITMQ_URL,
    exchange = process.env.RABBITMQ_EXCHANGE || 'domain.events',
    intervalMs = DEFAULT_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    pool = db.pool,
    log = logger,
    connect
} = {}) {
    const amqpConnect = connect || ((u) => amqplib.connect(u));

    let conn = null;
    let channel = null;
    let connecting = null;
    let stopped = false;
    let timer = null;
    let inFlight = null;

    // Lazy connect with in-flight dedupe. Returns null while the broker is
    // unreachable — callers just skip the tick and retry on the next one.
    async function getChannel() {
        if (channel) return channel;
        if (!url || stopped) return null;
        if (!connecting) {
            connecting = (async () => {
                try {
                    const connection = await amqpConnect(url);
                    conn = connection;
                    if (typeof connection.on === 'function') {
                        connection.on('error', (err) =>
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

    async function markSent(client, id) {
        await client.query("UPDATE outbox_events SET status = 'sent', sent_at = now() WHERE id = $1", [id]);
    }

    async function markAttemptFailed(client, row, err) {
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

    // One poll iteration: claim → publish → mark. Exported on the handle so
    // tests can drive it deterministically without timers.
    async function tick() {
        if (stopped) return;
        const ch = await getChannel();
        if (!ch) return;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
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
                        messageId: row.payload && row.payload.correlationId,
                        headers: { 'x-event-id': row.payload && row.payload.correlationId }
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

    function schedule() {
        if (stopped) return;
        timer = setTimeout(run, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    async function run() {
        inFlight = tick();
        try {
            await inFlight;
        } finally {
            inFlight = null;
            schedule();
        }
    }

    function start() {
        if (stopped) return;
        if (!url) {
            log.info('RABBITMQ_URL unset — outbox relay disabled (events stay pending in outbox_events)');
            return;
        }
        log.info({ exchange, intervalMs }, 'outbox relay started');
        schedule();
    }

    async function stop() {
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

module.exports = { createRelay };
