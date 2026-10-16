/**
 * 0001_baseline — frozen copy of the legacy `db/schema.sql` bootstrap schema.
 *
 * This is the schema as deployed BEFORE versioned migrations existed. Databases
 * that were already provisioned by the old initSchema()/initdb flow must stamp
 * this migration instead of running it:
 *
 *     node scripts/stamp-baseline.js
 *     # or: pnpm --filter @strafor/api exec node-pg-migrate up 0001_baseline --fake
 *
 * Everything after 0001 normalizes this shape (snake_case, applications split,
 * skills tables, audit logs, ...).
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            "firstName" VARCHAR(100) NOT NULL,
            "lastName" VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(10) NOT NULL CHECK (role IN ('admin', 'hr')),
            location JSONB,
            "lastLogin" TIMESTAMPTZ DEFAULT now(),
            "loggedOut" BOOLEAN DEFAULT FALSE,
            active BOOLEAN DEFAULT TRUE,
            "createdAt" TIMESTAMPTZ DEFAULT now(),
            "updatedAt" TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS settings (
            id SERIAL PRIMARY KEY,
            company JSONB,
            linkedin JSONB,
            occ JSONB,
            theme VARCHAR(50),
            notifications BOOLEAN,
            "userId" VARCHAR(255) UNIQUE,
            "createdAt" TIMESTAMPTZ DEFAULT now(),
            "updatedAt" TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS vacancies (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            company VARCHAR(255) NOT NULL,
            location VARCHAR(255) NOT NULL,
            type VARCHAR(50) NOT NULL,
            description TEXT NOT NULL,
            requirements TEXT NOT NULL,
            responsibilities TEXT NOT NULL,
            skills_required TEXT[] DEFAULT '{}',
            experience_level VARCHAR(50) NOT NULL,
            salary_range JSONB,
            benefits TEXT[] DEFAULT '{}',
            application_deadline TIMESTAMPTZ,
            remote_option BOOLEAN DEFAULT FALSE,
            status VARCHAR(50) DEFAULT 'Active',
            external_postings JSONB,
            created_by VARCHAR(255) NOT NULL,
            department VARCHAR(100) NOT NULL,
            "createdAt" TIMESTAMPTZ DEFAULT now(),
            "updatedAt" TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS candidates (
            id SERIAL PRIMARY KEY,
            first_name VARCHAR(100) NOT NULL,
            last_name VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL,
            phone VARCHAR(50) NOT NULL,
            linkedin VARCHAR(255),
            experience INTEGER NOT NULL,
            education VARCHAR(255) NOT NULL,
            location VARCHAR(255) NOT NULL,
            skills TEXT NOT NULL,
            resume VARCHAR(255),
            status VARCHAR(50) DEFAULT 'pending',
            applied_at TIMESTAMPTZ DEFAULT now(),
            applied_for INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
            current_position VARCHAR(255),
            hiring_feedback TEXT,
            ai_insights TEXT,
            ai_feedback_analysis JSONB,
            feedback_timestamp TIMESTAMPTZ,
            "createdAt" TIMESTAMPTZ DEFAULT now(),
            "updatedAt" TIMESTAMPTZ DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_candidates_applied_for ON candidates(applied_for);
        CREATE INDEX IF NOT EXISTS idx_candidates_applied_at ON candidates(applied_at);
        CREATE INDEX IF NOT EXISTS idx_vacancies_department ON vacancies(department);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE IF EXISTS candidates;
        DROP TABLE IF EXISTS vacancies;
        DROP TABLE IF EXISTS settings;
        DROP TABLE IF EXISTS users;
    `);
};
