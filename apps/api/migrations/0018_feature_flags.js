exports.up = (pgm) => {
    pgm.createTable('feature_flags', {
        id: 'id',
        key: { type: 'varchar(80)', notNull: true, unique: true },
        description: { type: 'text' },
        enabled: { type: 'boolean', default: false },
        rollout_percentage: { type: 'integer', default: 0 },
        updated_by: { type: 'integer' },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    pgm.sql(
        'ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_rollout_percentage_check ' +
            'CHECK (rollout_percentage BETWEEN 0 AND 100)'
    );

    pgm.sql(`INSERT INTO feature_flags (key, description, enabled) VALUES
    ('ai_matching', 'AI candidate-vacancy matching', true),
    ('video_interviews', 'Video interview integration', false),
    ('bulk_operations', 'Bulk candidate operations', false),
    ('public_careers_site', 'Public careers site', true),
    ('webhooks_outbound', 'Outbound webhook delivery', false),
    ('sso_saml', 'SAML SSO integration', false),
    ('mfa_enforcement', 'MFA for admin accounts', false),
    ('data_retention_auto', 'Automated data retention policies', false)
  ON CONFLICT (key) DO NOTHING;`);
};

exports.down = (pgm) => {
    pgm.dropTable('feature_flags');
};
