import crypto from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Transactional outbox writer.
 *
 * User mutations call recordOutboxEvent() with the SAME pg client that
 * performs the business write, so the event row commits or rolls back
 * together with the mutation — no dual-write window. src/outboxRelay.ts
 * later publishes pending rows to RabbitMQ (at-least-once delivery).
 * Mirrors apps/api/utils/outbox.js.
 *
 * The stored payload is the full event envelope
 *   { type, version, occurredAt, correlationId, payload }
 * matching packages/contracts/events. correlationId is a uuid generated per
 * outbox row — it doubles as the stable event id consumers use for
 * idempotent dedupe.
 */

/** Downstream projection payload for the strafor.identity.user_* events.
 *  Carries display fields only — never passwords, tokens or secrets. */
export interface UserLifecyclePayload extends Record<string, unknown> {
    userId: number;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
}

export interface RecordOutboxInput {
    aggregateType: string;
    aggregateId: string | number;
    /** Routing key, e.g. 'strafor.identity.user_created'. */
    eventType: string;
    payload: Record<string, unknown>;
    version?: number;
    /** Request correlation id; defaults to a fresh uuid (consumer dedupe key). */
    correlationId?: string;
}

/**
 * Insert a pending outbox_events row inside the caller's transaction.
 * Throws on DB error so the caller's mutation rolls back with it.
 */
export async function recordOutboxEvent(
    client: PoolClient,
    { aggregateType, aggregateId, eventType, payload, version = 1, correlationId }: RecordOutboxInput
): Promise<{ id: string; correlationId: string }> {
    const envelope = {
        type: eventType,
        version,
        occurredAt: new Date().toISOString(),
        correlationId: correlationId || crypto.randomUUID(),
        payload
    };
    const { rows } = await client.query<{ id: string }>(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [aggregateType, String(aggregateId), eventType, JSON.stringify(envelope)]
    );
    return { id: String(rows[0]!.id), correlationId: envelope.correlationId };
}
