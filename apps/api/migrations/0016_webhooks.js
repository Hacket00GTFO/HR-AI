exports.up = (pgm) => {
    pgm.createTable('webhooks', {
        id: 'id',
        url: { type: 'text', notNull: true },
        description: { type: 'varchar(255)' },
        events: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
        secret: { type: 'varchar(128)' },
        active: { type: 'boolean', default: true },
        created_by: { type: 'integer' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    pgm.createTable('webhook_deliveries', {
        id: 'id',
        webhook_id: {
            type: 'integer',
            notNull: true,
            references: 'webhooks(id)'
        },
        event_type: { type: 'varchar(100)', notNull: true },
        payload: { type: 'jsonb' },
        status_code: { type: 'integer' },
        response_body: { type: 'text' },
        attempts: { type: 'integer', default: 0 },
        status: { type: 'varchar(20)', default: 'pending' },
        next_retry_at: { type: 'timestamptz' },
        delivered_at: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    pgm.addIndex('webhook_deliveries', ['webhook_id', { name: 'created_at', sort: 'DESC' }]);
};

exports.down = (pgm) => {
    pgm.dropTable('webhook_deliveries');
    pgm.dropTable('webhooks');
};
