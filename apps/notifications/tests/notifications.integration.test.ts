import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import amqplib from 'amqplib';
import nodemailer, { type Transporter } from 'nodemailer';
import { runner } from 'node-pg-migrate';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { createPool } from '../src/db.js';
import { loadConfig, type ServiceConfig } from '../src/config.js';
import { createTransport } from '../src/mailer.js';
import { createApp } from '../src/app.js';
import { processNextNotification, startWorker } from '../src/worker.js';
import { startConsumer } from '../src/consumer.js';
import type { EventPublisher } from '../src/events.js';
import type { ServiceLogger } from '@strafor/node-common';

const RUN = process.env.TEST_DATABASE_URL && process.env.TEST_SMTP_HOST;
const RUN_MQ = RUN && process.env.TEST_RABBITMQ_URL;
const MAILPIT_API = process.env.TEST_MAILPIT_API || 'http://localhost:58025';

const silentLog = new Proxy({} as never, {
    get: () => () => {}
}) as ServiceLogger;

const fakePublisher: EventPublisher = {
    publish: async () => true,
    close: async () => {}
};

async function mailpitSubjects(): Promise<string[]> {
    const res = await fetch(`${MAILPIT_API}/api/v1/messages`);
    const json = (await res.json()) as { messages?: Array<{ Subject: string }> };
    return (json.messages ?? []).map((m) => m.Subject);
}

describe.skipIf(!RUN)('notifications integration (needs TEST_DATABASE_URL + TEST_SMTP_*)', () => {
    let pool: Pool;
    let config: ServiceConfig;
    let transporter: Transporter;
    let app: Express;

    const SERVICE = { 'X-Service-Token': 'test-service-token' };
    const ADMIN = { 'X-User-Id': '1', 'X-User-Role': 'admin' };

    beforeAll(async () => {
        const env = {
            ...process.env,
            DATABASE_URL: process.env.TEST_DATABASE_URL,
            SMTP_HOST: process.env.TEST_SMTP_HOST,
            SMTP_PORT: process.env.TEST_SMTP_PORT ?? '1025',
            SMTP_FROM: 'StraforAI Test <test@strafor.local>',
            SERVICE_AUTH_TOKEN: 'test-service-token'
        } as Record<string, string>;
        config = loadConfig(env);
        pool = createPool(config.DATABASE_URL);
        transporter = createTransport(config);

        await runner({
            databaseUrl: config.DATABASE_URL,
            dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations'),
            direction: 'up',
            migrationsTable: 'pgmigrations',
            migrationsSchema: 'public',
            schema: 'public',
            count: Infinity,
            log: () => {}
        });
        await pool.query('TRUNCATE notification_logs, notification_preferences');
        app = createApp({ pool, transporter, config, log: silentLog });
    });

    afterAll(async () => {
        await pool.end();
        transporter.close();
    });

    it('rejects send without credentials', async () => {
        const res = await request(app)
            .post('/v1/notifications/send')
            .set('Idempotency-Key', 'key-noauth-1')
            .send({ to: 'a@b.co', template: 'application.received' });
        expect(res.status).toBe(401);
    });

    it('rejects send without Idempotency-Key', async () => {
        const res = await request(app)
            .post('/v1/notifications/send')
            .set(SERVICE)
            .send({ to: 'a@b.co', template: 'application.received' });
        expect(res.status).toBe(400);
    });

    it('queues a send, worker delivers via SMTP, replay returns original', async () => {
        const send = await request(app)
            .post('/v1/notifications/send')
            .set(SERVICE)
            .set('Idempotency-Key', 'itest-send-1')
            .send({
                to: 'candidate@example.com',
                template: 'application.received',
                payload: { name: 'Ana', vacancyTitle: 'Backend Dev' }
            });
        expect(send.status).toBe(202);
        expect(send.body.status).toBe('queued');
        const id = send.body.id as string;

        // Replay: same key → same row, no duplicate.
        const replay = await request(app)
            .post('/v1/notifications/send')
            .set(SERVICE)
            .set('Idempotency-Key', 'itest-send-1')
            .send({ to: 'other@example.com', template: 'application.received' });
        expect(replay.status).toBe(202);
        expect(replay.body.id).toBe(id);
        expect(replay.body.replayed).toBe(true);

        expect(
            await processNextNotification({ pool, transporter, config, publisher: fakePublisher, log: silentLog })
        ).toBe(true);

        const { rows } = await pool.query(`SELECT status, sent_at FROM notification_logs WHERE id = $1`, [id]);
        expect(rows[0].status).toBe('sent');
        expect(rows[0].sent_at).toBeTruthy();

        const subjects = await mailpitSubjects();
        expect(subjects.some((s) => s.includes('We received your application'))).toBe(true);
    });

    it('returns 404 for unknown templates', async () => {
        const res = await request(app)
            .post('/v1/notifications/send')
            .set(SERVICE)
            .set('Idempotency-Key', 'itest-unknown-tpl')
            .send({ to: 'a@b.co', template: 'no.such.template' });
        expect(res.status).toBe(404);
    });

    it('suppresses sends when the user opted out', async () => {
        const put = await request(app)
            .put('/v1/notifications/preferences')
            .set({ 'X-User-Id': '55', 'X-User-Role': 'candidate' })
            .send({ email: false });
        expect(put.status).toBe(200);
        expect(put.body.channels.email).toBe(false);

        const get = await request(app)
            .get('/v1/notifications/preferences')
            .set({ 'X-User-Id': '55', 'X-User-Role': 'candidate' });
        expect(get.body.channels.email).toBe(false);

        const send = await request(app)
            .post('/v1/notifications/send')
            .set(SERVICE)
            .set('Idempotency-Key', 'itest-suppressed-1')
            .send({
                to: 'opted-out@example.com',
                template: 'application.received',
                userId: 55
            });
        expect(send.status).toBe(202);
        expect(send.body.status).toBe('suppressed');
    });

    it('admin lists logs with filters; non-admin is 403', async () => {
        const list = await request(app).get('/v1/notifications?status=sent&page=1&pageSize=10').set(ADMIN);
        expect(list.status).toBe(200);
        expect(list.body.items.length).toBeGreaterThanOrEqual(1);
        expect(list.body.items[0].status).toBe('sent');

        const forbidden = await request(app)
            .get('/v1/notifications')
            .set({ 'X-User-Id': '2', 'X-User-Role': 'candidate' });
        expect(forbidden.status).toBe(403);
    });

    it('SMTP failure reschedules with backoff, then fails permanently after max attempts', async () => {
        const deadTransport = nodemailer.createTransport({ host: '127.0.0.1', port: 59999 });
        const send = await request(app)
            .post('/v1/notifications/send')
            .set(SERVICE)
            .set('Idempotency-Key', 'itest-retry-1')
            .send({ to: 'retry@example.com', template: 'application.received' });
        const id = send.body.id as string;

        const deps = { pool, transporter: deadTransport, config, publisher: fakePublisher, log: silentLog };
        expect(await processNextNotification(deps)).toBe(true);
        let { rows } = await pool.query(
            `SELECT status, attempts, next_attempt_at FROM notification_logs WHERE id = $1`,
            [id]
        );
        expect(rows[0].status).toBe('queued');
        expect(rows[0].attempts).toBe(1);
        expect(rows[0].next_attempt_at).toBeTruthy();

        // Force remaining attempts to run now.
        for (let i = 0; i < config.MAX_ATTEMPTS; i++) {
            await pool.query(`UPDATE notification_logs SET next_attempt_at = now() WHERE id = $1`, [id]);
            await processNextNotification(deps);
        }
        ({ rows } = await pool.query(`SELECT status, attempts, error FROM notification_logs WHERE id = $1`, [id]));
        expect(rows[0].status).toBe('failed');
        expect(rows[0].attempts).toBe(config.MAX_ATTEMPTS);
        expect(rows[0].error).toBeTruthy();
        deadTransport.close();
    });
});

describe.skipIf(!RUN_MQ)('domain-event consumer (needs TEST_RABBITMQ_URL)', () => {
    it('NotificationRequested event → queued → sent email', async () => {
        const env = {
            ...process.env,
            DATABASE_URL: process.env.TEST_DATABASE_URL,
            SMTP_HOST: process.env.TEST_SMTP_HOST,
            SMTP_PORT: process.env.TEST_SMTP_PORT ?? '1025',
            SMTP_FROM: 'StraforAI Test <test@strafor.local>',
            SERVICE_AUTH_TOKEN: 'test-service-token',
            RABBITMQ_URL: process.env.TEST_RABBITMQ_URL,
            WORKER_POLL_MS: '300'
        } as Record<string, string>;
        const config = loadConfig(env);
        const pool = createPool(config.DATABASE_URL);
        const transporter = createTransport(config);

        await runner({
            databaseUrl: config.DATABASE_URL,
            dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations'),
            direction: 'up',
            migrationsTable: 'pgmigrations',
            migrationsSchema: 'public',
            schema: 'public',
            count: Infinity,
            log: () => {}
        });

        const consumer = startConsumer(config.RABBITMQ_URL, config.RABBITMQ_EXCHANGE, pool, silentLog, 500);
        const worker = startWorker({ pool, transporter, config, publisher: fakePublisher, log: silentLog });

        // Publish a NotificationRequested event onto domain.events.
        // The queue + binding are asserted HERE first so the publish can't race
        // the consumer's async connect.
        const conn = await amqplib.connect(config.RABBITMQ_URL as string);
        const ch = await conn.createConfirmChannel();
        await ch.assertExchange(config.RABBITMQ_EXCHANGE, 'topic', { durable: true });
        await ch.assertQueue('notifications.domain-events', {
            durable: true,
            arguments: { 'x-queue-type': 'quorum' }
        });
        await ch.bindQueue('notifications.domain-events', config.RABBITMQ_EXCHANGE, 'strafor.notification.requested');
        const envelope = {
            type: 'strafor.notification.requested',
            version: 1,
            occurredAt: new Date().toISOString(),
            correlationId: randomUUID(),
            payload: {
                recipient: 'event-driven@example.com',
                template: 'interview.scheduled',
                payload: { name: 'Luis', vacancyTitle: 'SRE', scheduledAt: '2026-10-20 15:00' },
                locale: 'en'
            }
        };
        ch.publish(config.RABBITMQ_EXCHANGE, 'strafor.notification.requested', Buffer.from(JSON.stringify(envelope)), {
            persistent: true,
            contentType: 'application/json'
        });
        await ch.waitForConfirms();

        // Wait for the consumer → queue → worker → sent.
        const deadline = Date.now() + 15_000;
        let status: string | undefined;
        while (Date.now() < deadline) {
            const { rows } = await pool.query(
                `SELECT status FROM notification_logs WHERE to_email = 'event-driven@example.com' ORDER BY created_at DESC LIMIT 1`
            );
            status = rows[0]?.status;
            if (status === 'sent') break;
            await new Promise((r) => setTimeout(r, 400));
        }
        expect(status).toBe('sent');

        const subjects = await mailpitSubjects();
        expect(subjects.some((s) => s.includes('Interview scheduled'))).toBe(true);

        await ch.close();
        await conn.close();
        worker.stop();
        await consumer.close();
        await pool.end();
        transporter.close();
    }, 30_000);
});
