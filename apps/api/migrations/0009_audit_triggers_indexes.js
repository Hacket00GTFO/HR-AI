/**
 * 0009_audit_triggers_indexes — audit trail, updated_at triggers, final indexes.
 *
 *   audit_logs            — append-only record of mutating actions
 *   set_updated_at()      — trigger function keeping updated_at fresh on every
 *                           mutable table
 *   indexes               — applications FKs/status/applied_at, status history,
 *                           candidates.created_at, trgm indexes backing the
 *                           ILIKE searches in the models
 */
const UPDATED_AT_TABLES = ['users', 'settings', 'vacancies', 'candidates', 'applications'];

exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE audit_logs (
            id BIGSERIAL PRIMARY KEY,
            actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
    `);

    for (const table of UPDATED_AT_TABLES) {
        pgm.sql(`
            CREATE TRIGGER trg_${table}_updated_at
            BEFORE UPDATE ON ${table}
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        `);
    }

    pgm.sql(`
        CREATE INDEX idx_applications_candidate_id ON applications(candidate_id);
        CREATE INDEX idx_applications_vacancy_id ON applications(vacancy_id);
        CREATE INDEX idx_applications_status ON applications(status);
        CREATE INDEX idx_applications_applied_at ON applications(applied_at DESC);
        CREATE INDEX idx_application_status_history_application
            ON application_status_history(application_id);

        CREATE INDEX idx_candidates_created_at ON candidates(created_at DESC);

        CREATE INDEX idx_vacancies_title_trgm ON vacancies USING gin (title gin_trgm_ops);
        CREATE INDEX idx_vacancies_department_trgm ON vacancies USING gin (department gin_trgm_ops);
        CREATE INDEX idx_vacancies_location_trgm ON vacancies USING gin (location gin_trgm_ops);
        CREATE INDEX idx_candidates_name_trgm
            ON candidates USING gin ((first_name || ' ' || last_name) gin_trgm_ops);
        CREATE INDEX idx_candidates_email_trgm ON candidates USING gin (email gin_trgm_ops);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP INDEX IF EXISTS idx_applications_candidate_id;
        DROP INDEX IF EXISTS idx_applications_vacancy_id;
        DROP INDEX IF EXISTS idx_applications_status;
        DROP INDEX IF EXISTS idx_applications_applied_at;
        DROP INDEX IF EXISTS idx_application_status_history_application;
        DROP INDEX IF EXISTS idx_candidates_created_at;
        DROP INDEX IF EXISTS idx_vacancies_title_trgm;
        DROP INDEX IF EXISTS idx_vacancies_department_trgm;
        DROP INDEX IF EXISTS idx_vacancies_location_trgm;
        DROP INDEX IF EXISTS idx_candidates_name_trgm;
        DROP INDEX IF EXISTS idx_candidates_email_trgm;
    `);
    for (const table of UPDATED_AT_TABLES) {
        pgm.sql(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`);
    }
    pgm.sql(`
        DROP FUNCTION IF EXISTS set_updated_at();
        DROP TABLE IF EXISTS audit_logs;
    `);
};
