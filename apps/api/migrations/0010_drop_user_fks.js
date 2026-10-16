/**
 * 0010_drop_user_fks — users now live in the identity-auth database
 * (strafor_identity). Foreign keys from monolith tables INTO users can no
 * longer be enforced by Postgres once identity owns the table, so every FK
 * constraint referencing users(id) is dropped while the columns are KEPT —
 * the ids still match identity's users.id (import-legacy preserves them).
 *
 * Dropped (actual constraint names resolved dynamically, so pre-baseline
 * databases with divergent names are covered too):
 *   vacancies.created_by_user_id               vacancies_created_by_user_id_fkey
 *   applications.created_by                    applications_created_by_fkey
 *   application_status_history.changed_by      application_status_history_changed_by_fkey
 *   audit_logs.actor_user_id                   audit_logs_actor_user_id_fkey
 *   settings.user_id                           settings_user_id_fkey
 *
 * Each column gets a `deprecated` COMMENT noting the id references the
 * identity service's users table and is no longer FK-enforced.
 */
const DEPRECATED_COLUMNS = [
    ['vacancies', 'created_by_user_id'],
    ['applications', 'created_by'],
    ['application_status_history', 'changed_by'],
    ['audit_logs', 'actor_user_id'],
    ['settings', 'user_id']
];

const DEPRECATION_NOTE =
    'DEPRECATED: references users(id) owned by the identity-auth service ' +
    '(strafor_identity DB). FK dropped in 0010 — referential integrity is ' +
    'application-level now.';

exports.up = (pgm) => {
    // Drop EVERY foreign key in this database that references users(id),
    // whatever its name (inline REFERENCES → auto <table>_<col>_fkey).
    pgm.sql(`
        DO $$
        DECLARE r record;
        BEGIN
            FOR r IN
                SELECT conrelid::regclass::text AS tbl, conname
                FROM pg_constraint
                WHERE contype = 'f' AND confrelid = 'users'::regclass
            LOOP
                EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
            END LOOP;
        END $$;
    `);

    for (const [table, column] of DEPRECATED_COLUMNS) {
        pgm.sql(`COMMENT ON COLUMN ${table}.${column} IS '${DEPRECATION_NOTE}'`);
    }
};

exports.down = (pgm) => {
    for (const [table, column] of DEPRECATED_COLUMNS) {
        pgm.sql(`COMMENT ON COLUMN ${table}.${column} IS NULL`);
    }

    pgm.sql(`
        ALTER TABLE vacancies
            ADD CONSTRAINT vacancies_created_by_user_id_fkey
            FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

        ALTER TABLE applications
            ADD CONSTRAINT applications_created_by_fkey
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

        ALTER TABLE application_status_history
            ADD CONSTRAINT application_status_history_changed_by_fkey
            FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL;

        ALTER TABLE audit_logs
            ADD CONSTRAINT audit_logs_actor_user_id_fkey
            FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;

        ALTER TABLE settings
            ADD CONSTRAINT settings_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    `);
};
