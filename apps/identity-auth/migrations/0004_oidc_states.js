/**
 * 0004_oidc_states — transient state store for the OIDC authorization-code
 * flow (dev SSO plumbing; see src/routes/oidc.ts). Rows are single-use and
 * expire after ~10 minutes; expired rows are cleaned lazily on read.
 */
exports.up = (pgm) => {
    pgm.createTable('oidc_states', {
        state: { type: 'varchar(128)', primaryKey: true },
        nonce: { type: 'varchar(128)', notNull: true },
        expires_at: { type: 'timestamptz', notNull: true },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });
    pgm.createIndex('oidc_states', 'expires_at', { name: 'oidc_states_expires_at_idx' });
};

exports.down = (pgm) => {
    pgm.dropIndex('oidc_states', 'expires_at', { name: 'oidc_states_expires_at_idx' });
    pgm.dropTable('oidc_states');
};
