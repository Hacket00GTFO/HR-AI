/**
 * 0001_calendar_bridge — calendar-bridge schema (database: strafor_integrations).
 *
 *   calendar_events    — every event created through the bridge. The subject
 *                        is stored ONLY as subject_hash (SHA-256 hex) because
 *                        interview subjects routinely embed candidate names.
 *                        external_ref is the caller's idempotency key
 *                        (e.g. 'interview:<id>' from recruitment-core); at
 *                        most one SCHEDULED event may exist per ref.
 *   integration_audit  — append-only audit of bridge operations
 *                        (actor, action, external_ref). No request bodies,
 *                        no subjects, no attendee lists, no credentials.
 *   outbox_events      — transactional outbox for domain events
 *                        (strafor.integrations.*); rows are written inside
 *                        the business tx and published by the
 *                        service/sweeper.
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE calendar_events (
            id BIGSERIAL PRIMARY KEY,
            provider VARCHAR(10) NOT NULL CHECK (provider IN ('stub','m365')),
            provider_event_id VARCHAR(255) NOT NULL,
            -- SHA-256(subject) — the subject text itself is never persisted.
            subject_hash CHAR(64) NOT NULL,
            organizer_email VARCHAR(255) NOT NULL,
            attendee_count INTEGER NOT NULL DEFAULT 0,
            external_ref VARCHAR(120),
            start_at TIMESTAMPTZ NOT NULL,
            end_at TIMESTAMPTZ NOT NULL,
            online BOOLEAN NOT NULL DEFAULT false,
            join_url TEXT,
            status VARCHAR(15) NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled','cancelled')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            cancelled_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX calendar_events_provider_event_uidx
            ON calendar_events (provider, provider_event_id);
        -- Idempotency guard: one live (scheduled) event per external_ref.
        CREATE UNIQUE INDEX calendar_events_external_ref_live_uidx
            ON calendar_events (external_ref)
            WHERE status = 'scheduled' AND external_ref IS NOT NULL;
        CREATE INDEX calendar_events_external_ref_idx
            ON calendar_events (external_ref) WHERE external_ref IS NOT NULL;
        CREATE INDEX calendar_events_status_idx ON calendar_events (status);

        -- No bodies/PII: actor, action and the opaque external ref only.
        CREATE TABLE integration_audit (
            id BIGSERIAL PRIMARY KEY,
            actor VARCHAR(120) NOT NULL,            -- 'service' | 'user:<id>'
            action VARCHAR(30) NOT NULL
                CHECK (action IN ('free_busy','event_create','event_cancel','event_lookup')),
            external_ref VARCHAR(120),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX integration_audit_ref_idx
            ON integration_audit (external_ref) WHERE external_ref IS NOT NULL;
        CREATE INDEX integration_audit_created_idx
            ON integration_audit (created_at);

        -- Transactional outbox for domain events (strafor.integrations.*).
        CREATE TABLE outbox_events (
            id BIGSERIAL PRIMARY KEY,
            type VARCHAR(120) NOT NULL,
            payload JSONB NOT NULL,
            correlation_id VARCHAR(128),
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            published_at TIMESTAMPTZ,
            attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX outbox_events_pending_idx
            ON outbox_events (id) WHERE published_at IS NULL;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE outbox_events;
        DROP TABLE integration_audit;
        DROP TABLE calendar_events;
    `);
};
