/**
 * 0002_audit_extend — add ip_address, user_agent, immutable columns to
 * audit_logs and enforce immutability via trigger.
 */
exports.up = (pgm) => {
    pgm.addColumns('audit_logs', {
        ip_address: { type: 'inet' },
        user_agent: { type: 'text' },
        immutable: { type: 'boolean', notNull: true, default: true }
    });

    pgm.createFunction(
        'prevent_audit_update',
        [],
        { language: 'plpgsql', returns: 'trigger' },
        `BEGIN
            RAISE EXCEPTION 'Audit logs are immutable';
        END;`
    );

    pgm.createTrigger('audit_logs', 'audit_immutable', {
        when: 'BEFORE',
        operation: ['UPDATE', 'DELETE'],
        function: 'prevent_audit_update',
        language: 'plpgsql'
    });
};

exports.down = (pgm) => {
    pgm.dropTrigger('audit_logs', 'audit_immutable', { ifExists: true });
    pgm.dropFunction('prevent_audit_update', [], { ifExists: true });
    pgm.dropColumns('audit_logs', ['ip_address', 'user_agent', 'immutable'], { ifExists: true });
};
