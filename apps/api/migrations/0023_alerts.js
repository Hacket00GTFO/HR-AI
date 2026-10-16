// Alerts table — stores alerts received from Alertmanager via webhook.
exports.up = (pgm) => {
    pgm.createTable('alerts', {
        id: 'id',
        fingerprint: { type: 'text', notNull: true, unique: true },
        alertname: { type: 'text', notNull: true },
        severity: { type: 'text', notNull: true },
        service: { type: 'text' },
        container: { type: 'text' },
        status: { type: 'text', notNull: true },
        starts_at: { type: 'timestamptz', notNull: true },
        ends_at: { type: 'timestamptz' },
        summary: { type: 'text', default: "''" },
        description: { type: 'text', default: "''" },
        labels: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
        annotations: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
        generator_url: { type: 'text' },
        acknowledged_by: { type: 'integer' },
        acknowledged_at: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    pgm.sql('CREATE INDEX IF NOT EXISTS alerts_status_idx ON alerts (status)');
    pgm.sql('CREATE INDEX IF NOT EXISTS alerts_starts_at_idx ON alerts (starts_at DESC)');
    pgm.sql('CREATE INDEX IF NOT EXISTS alerts_severity_idx ON alerts (severity)');
};

exports.down = (pgm) => {
    pgm.sql('DROP INDEX IF EXISTS alerts_status_idx');
    pgm.sql('DROP INDEX IF EXISTS alerts_starts_at_idx');
    pgm.sql('DROP INDEX IF EXISTS alerts_severity_idx');
    pgm.dropTable('alerts');
};
