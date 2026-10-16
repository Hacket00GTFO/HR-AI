/**
 * 0012_job_executions — background job queue execution records.
 *
 * Tracks the lifecycle of jobs dispatched through the background jobs system:
 * pending → running → completed | failed. Payload is jsonb so arbitrary job
 * inputs can be stored alongside retry/error metadata.
 */
exports.up = (pgm) => {
    pgm.createTable('job_executions', {
        id: 'id',
        queue: { type: 'varchar(100)', notNull: true },
        job_type: { type: 'varchar(100)', notNull: true },
        status: { type: 'varchar(20)', notNull: true, default: "'pending'" },
        payload: { type: 'jsonb' },
        error: { type: 'text' },
        attempts: { type: 'integer', default: 0 },
        max_attempts: { type: 'integer', default: 3 },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        started_at: { type: 'timestamptz' },
        completed_at: { type: 'timestamptz' }
    });

    pgm.createIndex('job_executions', ['status', 'queue'], { name: 'idx_job_executions_status' });
    pgm.createIndex('job_executions', [{ name: 'created_at', sort: 'DESC' }], { name: 'idx_job_executions_created' });
};

exports.down = (pgm) => {
    pgm.dropTable('job_executions');
};
