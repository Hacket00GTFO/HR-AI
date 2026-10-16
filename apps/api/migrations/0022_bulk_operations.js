exports.up = (pgm) => {
    pgm.createTable('bulk_operations', {
        id: 'id',
        operation_type: { type: 'varchar(50)', notNull: true },
        entity_type: { type: 'varchar(50)', notNull: true },
        total_records: { type: 'integer', default: 0 },
        processed_records: { type: 'integer', default: 0 },
        failed_records: { type: 'integer', default: 0 },
        status: { type: 'varchar(20)', default: 'pending' },
        result_url: { type: 'text' },
        initiated_by: { type: 'integer' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        completed_at: { type: 'timestamptz' }
    });

    pgm.sql(
        'CREATE INDEX IF NOT EXISTS bulk_operations_status_created_at_idx ' +
            'ON bulk_operations (status, created_at DESC)'
    );
};

exports.down = (pgm) => {
    pgm.sql('DROP INDEX IF EXISTS bulk_operations_status_created_at_idx');
    pgm.dropTable('bulk_operations');
};
