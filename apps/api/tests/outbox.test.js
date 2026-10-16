// Transactional outbox tests — no live database or broker.
//   record(): fake pg client captures the INSERT and the stored envelope.
//   relay:    fake pool/client + fake confirm channel; tick() is driven
//             directly (no timers) via the injected `connect` override.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.RABBITMQ_EXCHANGE = 'domain.events';

const require = createRequire(import.meta.url);
const outbox = require('../utils/outbox');
const { createRelay } = require('../utils/outboxRelay');

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const VALID_SUBMITTED = {
    candidateId: 7,
    vacancyId: 1,
    email: 'ana.garcia@example.com',
    appliedAt: new Date().toISOString(),
    hasResume: true
};

function fakeTxClient(rows = []) {
    const queries = [];
    return {
        queries,
        query: vi.fn(async (text, params) => {
            queries.push({ text: String(text), params });
            if (String(text).includes('FROM outbox_events')) return { rows };
            if (String(text).startsWith('INSERT')) return { rows: [{ id: '11' }] };
            return { rows: [] };
        }),
        release: vi.fn()
    };
}

function fakeChannel({ failOn = () => false } = {}) {
    const channel = {
        published: [],
        assertExchange: vi.fn(async () => {}),
        publish: vi.fn((exchange, routingKey, body, opts) => {
            if (failOn(routingKey)) throw new Error('broker nacked');
            channel.published.push({ exchange, routingKey, body: JSON.parse(body.toString('utf8')), opts });
            return true;
        }),
        waitForConfirms: vi.fn(async () => {}),
        close: vi.fn(async () => {})
    };
    return channel;
}

describe('outbox.record', () => {
    it('inserts a pending row with a contract-validated envelope inside the caller tx', async () => {
        const client = fakeTxClient();
        const { id, correlationId } = await outbox.record(client, {
            aggregateType: 'application',
            aggregateId: 42,
            eventType: 'strafor.application.submitted',
            payload: { ...VALID_SUBMITTED, name: 'Ana Garcia', vacancyTitle: 'Frontend Engineer' }
        });

        expect(id).toBe('11');
        expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
        const insert = client.queries.find((q) => q.text.includes('INSERT INTO outbox_events'));
        expect(insert).toBeTruthy();
        expect(insert.params[0]).toBe('application');
        expect(insert.params[1]).toBe('42');
        expect(insert.params[2]).toBe('strafor.application.submitted');
        const envelope = insert.params[3];
        expect(envelope.type).toBe('strafor.application.submitted');
        expect(envelope.version).toBe(1);
        expect(envelope.correlationId).toBe(correlationId);
        expect(envelope.payload.email).toBe('ana.garcia@example.com');
        expect(envelope.payload.name).toBe('Ana Garcia');
    });

    it('applies contract defaults (hasResume) when omitted', async () => {
        const client = fakeTxClient();
        const noResume = { ...VALID_SUBMITTED };
        delete noResume.hasResume;
        await outbox.record(client, {
            aggregateType: 'application',
            aggregateId: 1,
            eventType: 'strafor.application.submitted',
            payload: noResume
        });
        const insert = client.queries.find((q) => q.text.includes('INSERT INTO outbox_events'));
        expect(insert.params[3].payload.hasResume).toBe(false);
    });

    it('throws (rolling back the caller tx) when the payload violates its contract', async () => {
        const client = fakeTxClient();
        await expect(
            outbox.record(client, {
                aggregateType: 'application',
                aggregateId: 1,
                eventType: 'strafor.application.submitted',
                payload: { candidateId: 'oops' }
            })
        ).rejects.toThrow(/violates its contract/);
        expect(client.queries.some((q) => q.text.includes('INSERT INTO outbox_events'))).toBe(false);
    });

    it('records unknown event types without schema validation', async () => {
        const client = fakeTxClient();
        const { correlationId } = await outbox.record(client, {
            aggregateType: 'vacancy',
            aggregateId: 3,
            eventType: 'strafor.future.uncontracted',
            payload: { whatever: true }
        });
        expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(client.queries.some((q) => q.text.includes('INSERT INTO outbox_events'))).toBe(true);
    });
});

describe('outboxRelay', () => {
    function makeRelay({ rows, channel, connectErr, maxAttempts } = {}) {
        const client = fakeTxClient(rows);
        const pool = { connect: vi.fn(async () => client) };
        const conn = {
            on: vi.fn(),
            createConfirmChannel: vi.fn(async () => channel),
            close: vi.fn(async () => {})
        };
        const relay = createRelay({
            url: 'amqp://test',
            exchange: 'domain.events',
            pool,
            log: silentLog,
            maxAttempts: maxAttempts ?? 10,
            connect: vi.fn(async () => {
                if (connectErr) throw connectErr;
                return conn;
            })
        });
        return { relay, client, pool, conn };
    }

    it('publishes pending rows to domain.events (routing key = event_type) and marks them sent', async () => {
        const channel = fakeChannel();
        const rows = [
            {
                id: '1',
                event_type: 'strafor.application.submitted',
                payload: {
                    type: 'strafor.application.submitted',
                    version: 1,
                    correlationId: 'evt-uuid-1',
                    payload: {}
                },
                attempts: 0
            }
        ];
        const { relay, client } = makeRelay({ rows, channel });

        await relay.tick();

        expect(channel.publish).toHaveBeenCalledTimes(1);
        const [exchange, routingKey, body, opts] = channel.publish.mock.calls[0];
        expect(exchange).toBe('domain.events');
        expect(routingKey).toBe('strafor.application.submitted');
        expect(JSON.parse(body.toString('utf8')).correlationId).toBe('evt-uuid-1');
        expect(opts.persistent).toBe(true);
        expect(opts.messageId).toBe('evt-uuid-1');

        const claim = client.queries.find((q) => q.text.includes('FOR UPDATE SKIP LOCKED'));
        expect(claim).toBeTruthy();
        const sent = client.queries.find((q) => q.text.includes("status = 'sent'"));
        expect(sent).toBeTruthy();
        expect(sent.params[0]).toBe('1');
        expect(client.queries.at(-1).text).toBe('COMMIT');
    });

    it('backs off with attempts+1 and a future next_attempt_at on publish failure', async () => {
        const channel = fakeChannel({ failOn: () => true });
        const rows = [{ id: '2', event_type: 'x.y', payload: { correlationId: 'c2' }, attempts: 0 }];
        const { relay, client } = makeRelay({ rows, channel });

        await relay.tick();

        const retry = client.queries.find((q) => q.text.includes('next_attempt_at = $3'));
        expect(retry).toBeTruthy();
        expect(retry.params[0]).toBe('2');
        expect(retry.params[1]).toBe(1); // attempts
        expect(retry.params[2].getTime()).toBeGreaterThan(Date.now());
        expect(client.queries.some((q) => q.text.includes("status = 'sent'"))).toBe(false);
        expect(client.queries.at(-1).text).toBe('COMMIT');
    });

    it('marks the row failed once attempts reach maxAttempts', async () => {
        const channel = fakeChannel({ failOn: () => true });
        const rows = [{ id: '3', event_type: 'x.y', payload: {}, attempts: 9 }];
        const { relay, client } = makeRelay({ rows, channel, maxAttempts: 10 });

        await relay.tick();

        const failed = client.queries.find((q) => q.text.includes('SET status = $2'));
        expect(failed).toBeTruthy();
        expect(failed.params[1]).toBe('failed');
        expect(failed.params[2]).toBe(10);
    });

    it('degrades gracefully when the broker is down — no crash, no claim', async () => {
        const channel = fakeChannel();
        const { relay, pool } = makeRelay({ rows: [], channel, connectErr: new Error('ECONNREFUSED') });

        await expect(relay.tick()).resolves.toBeUndefined();
        expect(pool.connect).not.toHaveBeenCalled();
        expect(silentLog.warn).toHaveBeenCalled();
    });

    it('stop() closes channel and connection', async () => {
        const channel = fakeChannel();
        const { relay, conn } = makeRelay({ rows: [], channel });
        await relay.tick();
        await relay.stop();
        expect(channel.close).toHaveBeenCalled();
        expect(conn.close).toHaveBeenCalled();
    });
});
