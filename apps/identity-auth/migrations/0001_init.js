/**
 * 0001_init — identity-auth schema: users, settings, refresh_tokens,
 * password_reset_tokens, audit_logs.
 *
 * Mirrors the monolith's hardened users/settings shape (post 0007/0009)
 * so scripts/import-legacy.js can copy rows 1:1 preserving ids — identity
 * ids must stay aligned with FK references in the monolith DB.
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            first_name VARCHAR(100) NOT NULL,
            last_name VARCHAR(100) NOT NULL,
            -- Always stored lowercased (app enforces + import lowercases).
            email VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(10) NOT NULL CHECK (role IN ('admin', 'hr')),
            location JSONB,
            last_login TIMESTAMPTZ DEFAULT now(),
            logged_out BOOLEAN NOT NULL DEFAULT FALSE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        );

        -- Defense in depth on top of app-level lowercasing: the unique index
        -- makes 'A@x.com' and 'a@x.com' collide even if code forgets.
        CREATE UNIQUE INDEX users_email_lower_uidx
            ON users (lower(email)) WHERE deleted_at IS NULL;

        CREATE TABLE settings (
            id SERIAL PRIMARY KEY,
            -- NULL user_id = the single global row (integration config:
            -- linkedin/occ secrets, theme, notifications). Secrets inside the
            -- JSONB blobs are AES-256-GCM encrypted at rest by the app.
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            company JSONB,
            linkedin JSONB,
            occ JSONB,
            theme VARCHAR(50),
            notifications BOOLEAN,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE UNIQUE INDEX settings_user_id_uidx
            ON settings (user_id) WHERE user_id IS NOT NULL;
        -- At most one global (user_id IS NULL) settings row.
        CREATE UNIQUE INDEX settings_single_global_uidx
            ON settings ((true)) WHERE user_id IS NULL;

        CREATE TABLE refresh_tokens (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            -- All tokens descending from one login share a family; refresh
            -- rotation carries it forward via replaced_by. Reuse of a revoked
            -- token revokes the whole family.
            family_id UUID NOT NULL,
            token_hash VARCHAR(64) NOT NULL UNIQUE, -- sha256 hex
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ,
            replaced_by BIGINT REFERENCES refresh_tokens(id),
            user_agent VARCHAR(500),
            ip VARCHAR(64),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
        CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
        CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

        CREATE TABLE password_reset_tokens (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash VARCHAR(64) NOT NULL, -- sha256 hex
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_password_reset_hash ON password_reset_tokens(token_hash);
        CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);

        -- actor_user_id is a PLAIN integer (no FK) on purpose: audit rows must
        -- survive user deletion and never block it.
        CREATE TABLE audit_logs (
            id BIGSERIAL PRIMARY KEY,
            actor_user_id INTEGER,
            action VARCHAR(100) NOT NULL,
            entity VARCHAR(50) NOT NULL,
            entity_id INTEGER,
            metadata JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_audit_logs_entity ON audit_logs(entity, entity_id);
        CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_user_id);
        CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

        CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER trg_users_updated_at
            BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        CREATE TRIGGER trg_settings_updated_at
            BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TRIGGER IF EXISTS trg_settings_updated_at ON settings;
        DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
        DROP FUNCTION IF EXISTS set_updated_at();
        DROP TABLE IF EXISTS audit_logs;
        DROP TABLE IF EXISTS password_reset_tokens;
        DROP TABLE IF EXISTS refresh_tokens;
        DROP TABLE IF EXISTS settings;
        DROP TABLE IF EXISTS users;
    `);
};
