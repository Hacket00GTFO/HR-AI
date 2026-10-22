/**
 * 0001_recruitment — consolidated recruitment-core schema (DB: strafor_recruitment).
 *
 * Reproduces the FINAL shape of the monolith (apps/api) migrations 0001–0010
 * for the tables this service owns:
 *
 *   vacancies                    — normalized salary_*, created_by_user_id (no
 *                                  FK — users live in strafor_identity),
 *                                  soft delete, canonical CHECKs, indexes
 *   candidates                   — + resume_document_id UUID (unenforced
 *                                  reference to documents-resumes; the legacy
 *                                  `resume` filename column is kept for the
 *                                  RESUMES_DIR fallback during migration)
 *   applications                 — candidate↔vacancy join; status CHECK kept
 *                                  as {pending,interview,accepted,rejected}
 *                                  (pipeline expansion is a later phase)
 *   application_status_history   — audit timeline; changed_by has no FK
 *   skills / candidate_skills / vacancy_skills — ESCO-aligned taxonomy
 *   users_projection             — display-name joins (vacancies.created_by,
 *                                  history.changed_by). Fed by the migration
 *                                  backfill; NEVER FK'd to identity users.
 *   outbox_events                — transactional outbox for domain events;
 *                                  rows are written inside the business tx
 *                                  and published by the service/sweeper.
 *
 * Intentionally NOT created: users, settings, audit_logs, countries, states,
 * candidate_embeddings, vacancy_embeddings — owned elsewhere (see
 * docs/extraction/recruitment-core.md §2).
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE EXTENSION IF NOT EXISTS unaccent;
        -- pgvector intentionally omitted: candidate_embeddings /
        -- vacancy_embeddings stay in ai-matching's database.
    `);

    pgm.sql(`
        CREATE TABLE vacancies (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            company VARCHAR(255) NOT NULL,
            location VARCHAR(255) NOT NULL,
            type VARCHAR(50) NOT NULL
                CONSTRAINT vacancies_type_check
                CHECK (type IN ('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship')),
            description TEXT NOT NULL,
            requirements TEXT NOT NULL,
            responsibilities TEXT NOT NULL,
            skills_required TEXT[] DEFAULT '{}',
            experience_level VARCHAR(50) NOT NULL
                CONSTRAINT vacancies_experience_level_check
                CHECK (experience_level IN ('Entry Level', 'Mid Level', 'Senior Level', 'Executive')),
            salary_min NUMERIC(12,2),
            salary_max NUMERIC(12,2),
            salary_currency VARCHAR(10),
            benefits TEXT[] DEFAULT '{}',
            application_deadline TIMESTAMPTZ,
            remote_option BOOLEAN DEFAULT FALSE,
            status VARCHAR(50) DEFAULT 'Active'
                CONSTRAINT vacancies_status_check
                CHECK (status IN ('Active', 'Closed', 'Draft', 'Archived')),
            external_postings JSONB,
            created_by_user_id INTEGER,
            department VARCHAR(100) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now(),
            deleted_at TIMESTAMPTZ,
            CONSTRAINT vacancies_salary_check
                CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
        );

        COMMENT ON COLUMN vacancies.created_by_user_id IS
            'DEPRECATED: references users(id) owned by the identity-auth service '
            '(strafor_identity DB). No FK — referential integrity is '
            'application-level; display names come from users_projection.';

        CREATE INDEX idx_vacancies_department ON vacancies(department);
        CREATE INDEX idx_vacancies_status ON vacancies(status) WHERE deleted_at IS NULL;
        CREATE INDEX idx_vacancies_type ON vacancies(type);
        CREATE INDEX idx_vacancies_location ON vacancies(location);
        CREATE INDEX idx_vacancies_created_at ON vacancies(created_at DESC);
        CREATE INDEX idx_vacancies_skills_required_gin ON vacancies USING GIN (skills_required);
        CREATE INDEX idx_vacancies_title_trgm ON vacancies USING gin (title gin_trgm_ops);
        CREATE INDEX idx_vacancies_department_trgm ON vacancies USING gin (department gin_trgm_ops);
        CREATE INDEX idx_vacancies_location_trgm ON vacancies USING gin (location gin_trgm_ops);

        CREATE TABLE candidates (
            id SERIAL PRIMARY KEY,
            first_name VARCHAR(100) NOT NULL,
            last_name VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            phone VARCHAR(50) NOT NULL,
            linkedin VARCHAR(255),
            experience INTEGER NOT NULL,
            education VARCHAR(255) NOT NULL,
            location VARCHAR(255) NOT NULL,
            skills TEXT NOT NULL,
            resume VARCHAR(255),
            resume_document_id UUID,
            current_position VARCHAR(255),
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now(),
            deleted_at TIMESTAMPTZ
        );

        COMMENT ON COLUMN candidates.resume IS
            'LEGACY: filename under RESUMES_DIR (monolith local storage). '
            'New uploads set resume_document_id instead; kept for the '
            'GET /v1/candidates/:id/resume legacy fallback.';
        COMMENT ON COLUMN candidates.resume_document_id IS
            'Unenforced reference to documents-resumes documents.id '
            '(strafor_documents DB).';

        CREATE INDEX idx_candidates_created_at ON candidates(created_at DESC);
        CREATE INDEX idx_candidates_name_trgm
            ON candidates USING gin ((first_name || ' ' || last_name) gin_trgm_ops);
        CREATE INDEX idx_candidates_email_trgm ON candidates USING gin (email gin_trgm_ops);

        CREATE TABLE applications (
            id SERIAL PRIMARY KEY,
            candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
            vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE RESTRICT,
            status VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'interview', 'accepted', 'rejected')),
            hiring_feedback TEXT,
            ai_insights TEXT,
            ai_feedback_analysis JSONB,
            feedback_timestamp TIMESTAMPTZ,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_by INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        );

        COMMENT ON COLUMN applications.created_by IS
            'DEPRECATED: references users(id) owned by the identity-auth service '
            '(strafor_identity DB). No FK — referential integrity is application-level.';

        -- At most one live application per (candidate, vacancy).
        CREATE UNIQUE INDEX applications_candidate_vacancy_active_uidx
            ON applications (candidate_id, vacancy_id)
            WHERE deleted_at IS NULL;

        CREATE INDEX idx_applications_candidate_id ON applications(candidate_id);
        CREATE INDEX idx_applications_vacancy_id ON applications(vacancy_id);
        CREATE INDEX idx_applications_status ON applications(status);
        CREATE INDEX idx_applications_applied_at ON applications(applied_at DESC);

        CREATE TABLE application_status_history (
            id BIGSERIAL PRIMARY KEY,
            application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            from_status VARCHAR(20),
            to_status VARCHAR(20) NOT NULL,
            changed_by INTEGER,
            changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            note TEXT
        );

        COMMENT ON COLUMN application_status_history.changed_by IS
            'DEPRECATED: references users(id) owned by the identity-auth service '
            '(strafor_identity DB). No FK — display names come from users_projection.';

        CREATE INDEX idx_application_status_history_application
            ON application_status_history(application_id);

        CREATE TABLE skills (
            id SERIAL PRIMARY KEY,
            name VARCHAR(150) NOT NULL UNIQUE,
            esco_uri VARCHAR(255),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE candidate_skills (
            candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
            skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (candidate_id, skill_id)
        );

        CREATE TABLE vacancy_skills (
            vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
            skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
            required BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (vacancy_id, skill_id)
        );

        -- Display-name projection of identity users (no cross-DB reads, no FK).
        -- Populated by the migration backfill and (optionally) a future
        -- strafor.identity.* event consumer — identity events today do not
        -- carry first/last names, so backfill is the primary feed.
        CREATE TABLE users_projection (
            id INTEGER PRIMARY KEY,
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            email VARCHAR(255),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- Transactional outbox: domain events are inserted in the same tx as
        -- the business write and published post-commit (sweeper retries).
        CREATE TABLE outbox_events (
            id BIGSERIAL PRIMARY KEY,
            type VARCHAR(120) NOT NULL,
            payload JSONB NOT NULL,
            correlation_id VARCHAR(128),
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            published_at TIMESTAMPTZ,
            attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX outbox_events_pending_idx
            ON outbox_events (id) WHERE published_at IS NULL;

        CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `);

    for (const table of ['vacancies', 'candidates', 'applications', 'users_projection']) {
        pgm.sql(`
            CREATE TRIGGER trg_${table}_updated_at
            BEFORE UPDATE ON ${table}
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        `);
    }
};

exports.down = (pgm) => {
    for (const table of ['vacancies', 'candidates', 'applications', 'users_projection']) {
        pgm.sql(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`);
    }
    pgm.sql(`
        DROP FUNCTION IF EXISTS set_updated_at();
        DROP TABLE outbox_events;
        DROP TABLE users_projection;
        DROP TABLE vacancy_skills;
        DROP TABLE candidate_skills;
        DROP TABLE skills;
        DROP TABLE application_status_history;
        DROP TABLE applications;
        DROP TABLE candidates;
        DROP TABLE vacancies;
        DROP EXTENSION IF EXISTS unaccent;
    `);
};
