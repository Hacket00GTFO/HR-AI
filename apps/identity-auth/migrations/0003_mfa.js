exports.up = (pgm) => {
    pgm.addColumns('users', {
        mfa_secret: { type: 'varchar(64)' },
        mfa_enabled: { type: 'boolean', default: false },
        mfa_backup_codes: { type: 'jsonb', default: pgm.func("'[]'::jsonb") }
    });

    pgm.createTable('login_attempts', {
        id: 'bigserial',
        user_id: { type: 'integer' },
        ip_address: { type: 'inet' },
        success: { type: 'boolean' },
        failure_reason: { type: 'varchar(100)' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    pgm.createIndex('login_attempts', ['user_id', 'created_at'], {
        name: 'login_attempts_user_id_created_at_idx',
        sort: { created_at: 'DESC' }
    });
};

exports.down = (pgm) => {
    pgm.dropIndex('login_attempts', 'login_attempts_user_id_created_at_idx');
    pgm.dropTable('login_attempts');
    pgm.dropColumns('users', ['mfa_secret', 'mfa_enabled', 'mfa_backup_codes']);
};
