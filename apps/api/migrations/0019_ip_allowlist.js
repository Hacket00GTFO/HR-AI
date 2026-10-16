exports.up = (pgm) => {
    pgm.createTable('ip_allowlist', {
        id: 'id',
        ip_cidr: { type: 'inet', notNull: true },
        label: { type: 'varchar(120)' },
        applies_to: { type: 'varchar(20)', default: 'admin' },
        created_by: { type: 'integer' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });
};

exports.down = (pgm) => {
    pgm.dropTable('ip_allowlist');
};
