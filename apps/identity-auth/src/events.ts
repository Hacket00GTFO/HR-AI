import crypto from 'node:crypto';
import amqp from 'amqplib';
import { logger } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';

/**
 * Best-effort domain event publisher → RabbitMQ.
 * Exchange + queue are both named `domain.events`; the queue is quorum-typed
 * and bound with '#' so every event type lands there. Publishing uses the
 * event `type` as the routing key. Broker absence is tolerated: failures are
 * logged and the request continues.
 */

const EXCHANGE = 'domain.events';
const QUEUE = 'domain.events';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

let conn: AmqpConnection | null = null;
let channel: AmqpChannel | null = null;
let connecting: Promise<AmqpChannel | null> | null = null;
let disabled = false;

async function connect(url: string): Promise<AmqpChannel | null> {
    try {
        const connection = await amqp.connect(url);
        conn = connection;
        connection.on('error', (err) => logger.error({ err: err.message }, 'amqp connection error'));
        connection.on('close', () => {
            channel = null;
            conn = null;
        });
        const ch = await connection.createChannel();
        channel = ch;
        await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
        await ch.assertQueue(QUEUE, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
        await ch.bindQueue(QUEUE, EXCHANGE, '#');
        logger.info('amqp publisher connected');
        return ch;
    } catch (err) {
        logger.error({ err: (err as Error).message }, 'amqp connect failed — events disabled this boot');
        return null;
    }
}

async function getChannel(config: ServiceConfig): Promise<AmqpChannel | null> {
    if (channel) return channel;
    if (disabled || !config.rabbitmqUrl) return null;
    if (!connecting) {
        connecting = connect(config.rabbitmqUrl).finally(() => {
            connecting = null;
        });
    }
    return connecting;
}

export interface DomainEvent {
    type: string;
    version: number;
    occurredAt: string;
    correlationId: string;
    payload: Record<string, unknown>;
}

export async function publishEvent(config: ServiceConfig, event: DomainEvent): Promise<void> {
    const ch = await getChannel(config);
    if (!ch) return;
    try {
        ch.publish(EXCHANGE, event.type, Buffer.from(JSON.stringify(event)), {
            persistent: true,
            contentType: 'application/json'
        });
    } catch (err) {
        logger.error({ err: (err as Error).message, type: event.type }, 'event publish failed');
    }
}

export function buildEvent(type: string, payload: Record<string, unknown>, correlationId: string): DomainEvent {
    return {
        type,
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: correlationId || crypto.randomUUID(),
        payload
    };
}

export async function shutdownEvents(): Promise<void> {
    try {
        if (channel) await channel.close();
        if (conn) await conn.close();
    } catch {
        /* best effort */
    }
    channel = null;
    conn = null;
    disabled = false;
}

/** Test hook — drop cached connection state. */
export function _resetEvents(): void {
    channel = null;
    conn = null;
    connecting = null;
    disabled = false;
}
