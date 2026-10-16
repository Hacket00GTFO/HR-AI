exports.up = (pgm) => {
    pgm.createTable('api_keys', {
        id: 'id',
        name: { type: 'varchar(120)', notNull: true },
        key_prefix: { type: 'varchar(20)', notNull: true },
        key_hash: { type: 'varchar(64)', notNull: true, unique: true },
        scopes: { type: 'jsonb', default: pgm.func('\'["read"]\'::jsonb') },
        expires_at: { type: 'timestamptz' },
        last_used_at: { type: 'timestamptz' },
        created_by: { type: 'integer' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        revoked_at: { type: 'timestamptz' }
    });

    pgm.sql('CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL');
};

exports.down = (pgm) => {
    pgm.dropTable('api_keys');
};
