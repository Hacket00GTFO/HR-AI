/**
 * 0004_applications — the core normalization: split per-application fields off
 * `candidates` into a real `applications` table (candidate ↔ vacancy, many-to-many).
 *
 * Backfill:
 *   - one application row per legacy candidate (candidates.applied_for → vacancy_id)
 *   - per-application fields moved: status (lowercased), hiring_feedback,
 *     ai_insights, ai_feedback_analysis, feedback_timestamp, applied_at
 *   - one "initial" application_status_history row per application
 *   - candidate emails normalized to lowercase and deduplicated (earliest row
 *     kept; the loser rows' applications are re-pointed at the keeper before
 *     the loser rows are deleted)
 *   - candidates.email becomes UNIQUE; candidates gains deleted_at (soft delete)
 *
 * The legacy candidates→vacancies ON DELETE CASCADE FK is dropped — application
 * rows are the link now and use RESTRICT + soft delete.
 */
exports.up = (pgm) => {
    pgm.sql(`
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
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        );

        CREATE TABLE application_status_history (
            id BIGSERIAL PRIMARY KEY,
            application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            from_status VARCHAR(20),
            to_status VARCHAR(20) NOT NULL,
            changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            note TEXT
        );

        -- Normalize candidate emails before dedupe so 'A@x.com'/'a@x.com' merge.
        UPDATE candidates SET email = lower(btrim(email));

        -- Backfill one application per legacy candidate row.
        INSERT INTO applications (
            candidate_id, vacancy_id, status, hiring_feedback, ai_insights,
            ai_feedback_analysis, feedback_timestamp, applied_at, created_at, updated_at
        )
        SELECT id,
               applied_for,
               lower(COALESCE(status, 'pending')),
               hiring_feedback,
               ai_insights,
               ai_feedback_analysis,
               feedback_timestamp,
               COALESCE(applied_at, now()),
               COALESCE(created_at, now()),
               COALESCE(updated_at, now())
        FROM candidates;

        -- Re-point applications owned by duplicate candidate rows to the
        -- earliest row sharing the same email.
        WITH ranked AS (
            SELECT id,
                   first_value(id) OVER (PARTITION BY email ORDER BY id) AS keep_id
            FROM candidates
        )
        UPDATE applications a
        SET candidate_id = r.keep_id
        FROM ranked r
        WHERE a.candidate_id = r.id AND r.keep_id <> r.id;

        -- The merge above can leave two applications for the same
        -- (candidate, vacancy) pair — keep the earliest.
        DELETE FROM applications a
        USING applications b
        WHERE a.candidate_id = b.candidate_id
          AND a.vacancy_id = b.vacancy_id
          AND a.id > b.id;

        -- Seed the status history with the migrated initial state.
        INSERT INTO application_status_history (application_id, from_status, to_status, changed_at, note)
        SELECT id, NULL, status, applied_at, 'Migrated from legacy schema'
        FROM applications;

        -- Now safe to remove the duplicate candidate rows.
        DELETE FROM candidates c
        WHERE EXISTS (
            SELECT 1 FROM candidates earlier
            WHERE earlier.email = c.email AND earlier.id < c.id
        );

        ALTER TABLE candidates ADD CONSTRAINT candidates_email_key UNIQUE (email);

        -- At most one live application per (candidate, vacancy).
        CREATE UNIQUE INDEX applications_candidate_vacancy_active_uidx
            ON applications (candidate_id, vacancy_id)
            WHERE deleted_at IS NULL;

        -- Move complete: drop the legacy per-application columns (this also
        -- drops candidates_applied_for_fkey, idx_candidates_applied_for and
        -- idx_candidates_applied_at, which depend on those columns).
        ALTER TABLE candidates
            DROP COLUMN status,
            DROP COLUMN hiring_feedback,
            DROP COLUMN ai_insights,
            DROP COLUMN ai_feedback_analysis,
            DROP COLUMN feedback_timestamp,
            DROP COLUMN applied_at,
            DROP COLUMN applied_for,
            ADD COLUMN deleted_at TIMESTAMPTZ;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        -- Restore the legacy per-application columns on candidates.
        ALTER TABLE candidates
            ADD COLUMN status VARCHAR(50) DEFAULT 'pending',
            ADD COLUMN hiring_feedback TEXT,
            ADD COLUMN ai_insights TEXT,
            ADD COLUMN ai_feedback_analysis JSONB,
            ADD COLUMN feedback_timestamp TIMESTAMPTZ,
            ADD COLUMN applied_at TIMESTAMPTZ DEFAULT now(),
            ADD COLUMN applied_for INTEGER,
            DROP COLUMN deleted_at;

        -- Backfill from the candidate's most recent application.
        UPDATE candidates c
        SET (status, hiring_feedback, ai_insights, ai_feedback_analysis,
             feedback_timestamp, applied_at, applied_for) = (
            SELECT a.status, a.hiring_feedback, a.ai_insights, a.ai_feedback_analysis,
                   a.feedback_timestamp, a.applied_at, a.vacancy_id
            FROM applications a
            WHERE a.candidate_id = c.id
            ORDER BY a.applied_at DESC, a.id DESC
            LIMIT 1
        );

        -- The legacy column was NOT NULL: candidates without any application
        -- cannot be represented in the old schema.
        DELETE FROM candidates WHERE applied_for IS NULL;
        ALTER TABLE candidates ALTER COLUMN applied_for SET NOT NULL;
        ALTER TABLE candidates
            ADD CONSTRAINT candidates_applied_for_fkey
            FOREIGN KEY (applied_for) REFERENCES vacancies(id) ON DELETE CASCADE;

        CREATE INDEX idx_candidates_applied_for ON candidates(applied_for);
        CREATE INDEX idx_candidates_applied_at ON candidates(applied_at);

        ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_email_key;

        DROP TABLE application_status_history;
        DROP TABLE applications;
    `);
};
