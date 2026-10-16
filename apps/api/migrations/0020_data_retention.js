exports.up = (pgm) => {
    pgm.createTable('data_retention_policies', {
        id: 'id',
        entity_type: { type: 'varchar(50)', notNull: true },
        retention_days: { type: 'integer', notNull: true },
        action: { type: 'varchar(20)', default: 'delete' },
        active: { type: 'boolean', default: true },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    pgm.createTable('data_subject_requests', {
        id: 'id',
        type: { type: 'varchar(20)', notNull: true },
        email: { type: 'varchar(255)' },
        candidate_id: { type: 'integer' },
        status: { type: 'varchar(20)', default: 'pending' },
        requested_by: { type: 'varchar(50)' },
        result_url: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        completed_at: { type: 'timestamptz' }
    });

    pgm.sql(`
    INSERT INTO data_retention_policies (entity_type, retention_days, action, active) VALUES
      ('candidates', 730, 'anonymize', true),
      ('applications', 365, 'archive', true),
      ('audit_logs', 2555, 'delete', true),
      ('resumes', 365, 'delete', true)
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
    pgm.dropTable('data_subject_requests');
    pgm.dropTable('data_retention_policies');
};
