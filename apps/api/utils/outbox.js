// Transactional outbox writer.
//
// Domain mutations call record() with the SAME pg client that performs the
// business write, so the event row commits or rolls back together with the
// mutation — no dual-write window. utils/outboxRelay.js later publishes the
// pending rows to RabbitMQ (at-least-once delivery).
//
// The stored payload is the full event envelope
//   { type, version, occurredAt, correlationId, payload }
// matching packages/contracts/events. correlationId is a uuid generated per
// outbox row — it doubles as the stable event id consumers use for
// idempotent dedupe (see apps/notifications consumer: `evt:${correlationId}`).
//
// When a Zod contract exists for eventType it is enforced here: an invalid
// envelope throws, rolling back the caller's transaction and surfacing the
// contract violation instead of silently dropping the event. Unknown event
// types are recorded as-is (forward-compatible).

const { randomUUID } = require('crypto');
const logger = require('./logger');

let cachedTypes = null;
function eventTypes() {
    if (cachedTypes === null) {
        try {
            cachedTypes = require('@strafor/contracts').EVENT_TYPES || {};
        } catch (err) {
            logger.warn(
                { err: err instanceof Error ? err.message : err },
                '@strafor/contracts unavailable — outbox events will not be schema-validated'
            );
            cachedTypes = {};
        }
    }
    return cachedTypes;
}

/**
 * Insert a pending outbox_events row inside the caller's transaction.
 *
 * @param {object} client   pg client (must already be inside BEGIN)
 * @param {object} event
 * @param {string} event.aggregateType  e.g. 'vacancy' | 'application' | 'candidate'
 * @param {string|number} event.aggregateId
 * @param {string} event.eventType      routing key, e.g. 'strafor.application.submitted'
 * @param {object} event.payload        domain payload (validated when a contract exists)
 * @param {number} [event.version]      envelope version (default 1)
 * @param {string} [event.correlationId] request correlation id; defaults to a
 *                                       fresh uuid (also the consumer dedupe key)
 * @returns {Promise<{id: string, correlationId: string}>}
 */
async function record(client, { aggregateType, aggregateId, eventType, payload, version = 1, correlationId }) {
    let envelope = {
        type: eventType,
        version,
        occurredAt: new Date().toISOString(),
        correlationId: correlationId || randomUUID(),
        payload
    };

    const schema = eventTypes()[eventType];
    if (schema) {
        const parsed = schema.safeParse(envelope);
        if (!parsed.success) {
            const err = new Error(`Outbox event ${eventType} violates its contract: ${parsed.error.message}`);
            err.status = 500;
            throw err;
        }
        envelope = parsed.data; // applies contract defaults (e.g. hasResume, skillsRequired)
    } else {
        logger.debug({ eventType }, 'outbox event has no registered contract — recorded unvalidated');
    }

    const { rows } = await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [aggregateType, String(aggregateId), eventType, envelope]
    );
    return { id: rows[0].id, correlationId: envelope.correlationId };
}

module.exports = { record };
