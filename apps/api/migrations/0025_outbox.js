/**
 * 0025_outbox — transactional outbox for domain events.
 *
 * Domain mutations (vacancy create/update/delete, application submit,
 * application status change) INSERT a row here inside the same transaction
 * as the business write (utils/outbox.js record()). A polling relay
 * (utils/outboxRelay.js) then publishes each pending row to the RabbitMQ
 * `domain.events` topic exchange with routing key = event_type and marks it
 * sent — guaranteeing at-least-once delivery without dual-write risk.
 *
 * `payload` stores the full event envelope
 *   { type, version, occurredAt, correlationId, payload }
 * — correlationId is a uuid generated per row and doubles as the stable
 * event id consumers use for idempotent dedupe.
 */
exports.up = (pgm) => {
    pgm.createTable('outbox_events', {
        id: { type: 'bigserial', primaryKey: true },
        aggregate_type: { type: 'varchar(100)', notNull: true },
        aggregate_id: { type: 'varchar(100)', notNull: true },
        event_type: { type: 'varchar(200)', notNull: true },
        payload: { type: 'jsonb', notNull: true },
        status: { type: 'varchar(20)', notNull: true, default: pgm.func("'pending'") },
        attempts: { type: 'integer', notNull: true, default: 0 },
        next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        sent_at: { type: 'timestamptz' }
    });

    pgm.addConstraint('outbox_events', 'outbox_events_status_check', {
        check: "status IN ('pending', 'sent', 'failed')"
    });

    // The relay's claim query: pending rows whose backoff has elapsed.
    pgm.createIndex('outbox_events', ['status', 'next_attempt_at'], {
        name: 'idx_outbox_events_pending',
        where: "status = 'pending'"
    });
};

exports.down = (pgm) => {
    pgm.dropTable('outbox_events');
};
