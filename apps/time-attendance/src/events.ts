import { randomUUID } from 'node:crypto';
import amqplib, { type Channel, type ChannelModel } from 'amqplib';
import { logger as rootLogger, type ServiceLogger } from '@strafor/node-common';
import type { z } from 'zod';

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

/**
 * Best-effort domain-event publisher on the `domain.events` topic exchange.
 * Broker absence is tolerated: connect/publish failures are logged and
 * swallowed so attendance/leave workflows never block on RabbitMQ.
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
            const envelope: EventEnvelope = {
                type,
                version: 1,
                occurredAt: new Date().toISOString(),
                correlationId: correlationId || randomUUID(),
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
