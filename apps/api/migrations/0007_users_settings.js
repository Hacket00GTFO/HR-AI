/**
 * 0007_users_settings — harden users and settings.
 *
 *   users    — deleted_at (soft delete), role CHECK re-asserted explicitly so
 *              pre-baseline databases get it too.
 *   settings — user_id VARCHAR → INTEGER FK → users(id) ON DELETE CASCADE.
 *              Orphan/non-numeric rows are dropped; NULL user_id stays allowed
 *              (global integration-config rows, e.g. LinkedIn/OCC, have no
 *              owner). The existing UNIQUE constraint on user_id is kept.
 */
exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;

        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'hr'));

        -- Drop settings rows whose user_id can never resolve to a users.id.
        DELETE FROM settings
        WHERE user_id IS NOT NULL
          AND (
              user_id !~ '^[0-9]+$'
              OR user_id::integer NOT IN (SELECT id FROM users)
          );

        ALTER TABLE settings
            ALTER COLUMN user_id TYPE INTEGER USING user_id::integer;

        ALTER TABLE settings
            ADD CONSTRAINT settings_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE settings DROP CONSTRAINT settings_user_id_fkey;
        ALTER TABLE settings ALTER COLUMN user_id TYPE VARCHAR(255) USING user_id::text;
        ALTER TABLE users DROP COLUMN deleted_at;
    `);
};
