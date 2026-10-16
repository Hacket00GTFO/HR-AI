// analytics — event-fed read models and ATS metrics.
// Skeleton: HTTP surface (/health, /ready, /v1/analytics/*) plus a RabbitMQ
// consumer stub that ingests domain events into in-memory counters. Real read
// models (funnel, time-to-hire, source-of-hire, recruiter load) land with the
// recruitment-core extraction — see docs/extraction/recruitment-core.md.
require('@strafor/node-common/tracing').startTracing({ serviceName: 'analytics' });
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const amqplib = require('amqplib');
const { createLogger, createMetrics } = require('@strafor/node-common');
const { loadConfig } = require('./config');

const QUEUE_NAME = 'analytics.domain-events';

// Event types analytics will build read models from (see
// packages/contracts/events). Legacy + recruitment-core families are both
// accepted during the transition.
const CONSUMED_EVENT_TYPES = [
    'strafor.vacancy.published',
    'strafor.recruitment.vacancy_published',
    'strafor.recruitment.vacancy_updated',
    'strafor.recruitment.vacancy_closed',
    'strafor.application.submitted',
    'strafor.recruitment.application_submitted',
    'strafor.candidate.status_changed',
    'strafor.recruitment.candidate_status_changed',
    'strafor.candidate.hiring_decision_recorded',
    'strafor.recruitment.hiring_decision_recorded',
    'strafor.matching.score_computed',
    'strafor.notification.sent'
];

// In-memory counters — placeholder until the read-model schema lands.
const eventCounts = new Map();
let lastEventAt = null;

// Prometheus metrics — created at module level so both the HTTP server and
// the RabbitMQ consumer can observe domain metrics.
const metrics = createMetrics({ serviceName: 'analytics' });
const eventsConsumedCounter = metrics.counter('analytics_events_consumed_total', 'Total analytics events consumed', [
    'type'
]);
const lastEventAgeGauge = metrics.gauge(
    'analytics_last_event_age_seconds',
    'Age of the last consumed event in seconds'
);

/** RabbitMQ consumer stub. Broker absence is tolerated — retries forever. */
function startConsumer(url, exchange, log, reconnectMs = 5000) {
    let conn = null;
    let stopped = false;
    let timer = null;

    async function connect() {
        if (stopped || !url) return;
        try {
            conn = await amqplib.connect(url);
            conn.on('close', () => {
                conn = null;
                if (!stopped) schedule();
            });
            conn.on('error', (err) => log.warn({ err: err.message }, 'rabbitmq consumer connection error'));
            const ch = await conn.createChannel();
            await ch.assertExchange(exchange, 'topic', { durable: true });
            await ch.assertQueue(QUEUE_NAME, {
                durable: true,
                arguments: { 'x-queue-type': 'quorum' }
            });
            for (const type of CONSUMED_EVENT_TYPES) {
                await ch.bindQueue(QUEUE_NAME, exchange, type);
            }
            await ch.consume(QUEUE_NAME, (msg) => {
                if (!msg) return;
                try {
                    const envelope = JSON.parse(msg.content.toString('utf8'));
                    eventCounts.set(envelope.type, (eventCounts.get(envelope.type) || 0) + 1);
                    lastEventAt = envelope.occurredAt || new Date().toISOString();
                    eventsConsumedCounter.inc({ type: envelope.type });
                    log.debug({ type: envelope.type, correlationId: envelope.correlationId }, 'event ingested');
                } catch (err) {
                    log.warn({ err: err.message }, 'dropping malformed event message');
                }
                ch.ack(msg); // never requeue: poisoned events must not loop
            });
            log.info({ queue: QUEUE_NAME, types: CONSUMED_EVENT_TYPES.length }, 'rabbitmq consumer ready');
        } catch (err) {
            conn = null;
            log.warn({ err: err.message }, 'rabbitmq consumer connect failed — retrying');
            schedule();
        }
    }

    function schedule() {
        if (stopped) return;
        timer = setTimeout(() => void connect(), reconnectMs);
        timer.unref();
    }

    void connect();

    // Periodically update the last-event-age gauge so it reflects the current
    // age even when no events are arriving.
    const ageTimer = setInterval(() => {
        if (lastEventAt) {
            const ageSec = (Date.now() - new Date(lastEventAt).getTime()) / 1000;
            lastEventAgeGauge.set({}, Math.max(0, ageSec));
        }
    }, 5000);
    ageTimer.unref();

    return {
        async close() {
            stopped = true;
            if (timer) clearTimeout(timer);
            clearInterval(ageTimer);
            try {
                await conn?.close();
            } catch {
                /* ignore */
            }
        }
    };
}

function createApp({ pool, log }) {
    const app = express();
    app.use(express.json({ limit: '256kb' }));

    // HTTP metrics middleware — before routes.
    app.use(metrics.httpMetricsMiddleware);

    // Prometheus scrape — before any rate limiter/auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    // Liveness — never touches dependencies.
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', service: 'analytics', timestamp: new Date().toISOString() });
    });

    // Readiness — db must answer.
    app.get('/ready', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ready', db: 'up' });
        } catch (err) {
            res.status(503).json({ status: 'not_ready', db: 'down' });
        }
    });

    // Skeleton read model: ingested-event counters. Real ATS metrics
    // (funnel, time-to-hire, source-of-hire, recruiter load) are added with
    // the read-model migrations.
    app.get('/v1/analytics/events', (req, res) => {
        res.json({
            counts: Object.fromEntries(eventCounts),
            lastEventAt
        });
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        log.error({ err: err.message }, 'unhandled express error');
        res.status(500).json({ error: 'Server error' });
    });

    return app;
}

async function main() {
    const config = loadConfig();
    process.env.SERVICE_NAME = config.SERVICE_NAME;
    const log = createLogger();

    const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
    pool.on('error', (err) => log.error({ err: err.message }, 'pg pool error'));

    const consumer = startConsumer(config.RABBITMQ_URL, config.RABBITMQ_EXCHANGE, log);
    const app = createApp({ pool, log });

    const server = app.listen(config.PORT, () => {
        log.info({ port: config.PORT }, 'analytics listening');
    });

    const shutdown = (signal) => {
        log.info({ signal }, 'shutting down');
        server.close(async () => {
            await consumer.close();
            await pool.end();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal boot error:', err);
        process.exit(1);
    });
}

module.exports = { createApp, startConsumer };
