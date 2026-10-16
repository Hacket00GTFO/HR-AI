exports.up = (pgm) => {
    pgm.createTable('approval_workflows', {
        id: 'id',
        name: { type: 'varchar(120)', notNull: true },
        entity_type: { type: 'varchar(50)', notNull: true },
        rules: { type: 'jsonb', notNull: true },
        active: { type: 'boolean', default: true },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    pgm.createTable('approval_requests', {
        id: 'id',
        workflow_id: {
            type: 'integer',
            notNull: true,
            references: 'approval_workflows(id)'
        },
        entity_type: { type: 'varchar(50)', notNull: true },
        entity_id: { type: 'integer', notNull: true },
        requested_by: { type: 'integer' },
        status: { type: 'varchar(20)', default: 'pending' },
        approved_by: { type: 'integer' },
        rejection_reason: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        resolved_at: { type: 'timestamptz' }
    });

    pgm.addIndex('approval_requests', ['status', 'entity_type']);
};

exports.down = (pgm) => {
    pgm.dropTable('approval_requests');
    pgm.dropTable('approval_workflows');
};
