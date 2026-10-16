/**
 * 0006_vacancies_normalize — structured salary, FK'd creator, soft delete,
 * canonical CHECK constraints and search indexes for vacancies.
 *
 *   - salary_min / salary_max / salary_currency columns backfilled from the
 *     legacy salary_range JSONB (the JSONB column is then dropped — models
 *     synthesize `salary_range` in API responses to keep the wire format)
 *   - created_by (free text, e.g. 'HR Admin') → created_by_user_id INT FK→users;
 *     backfilled where the legacy text matches a user email or full name,
 *     NULL otherwise
 *   - deleted_at for soft deletes
 *   - CHECK constraints matching the UI's canonical option sets
 *   - indexes: status/type/location/created_at + GIN on skills_required
 */
exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE vacancies
            ADD COLUMN salary_min NUMERIC(12,2),
            ADD COLUMN salary_max NUMERIC(12,2),
            ADD COLUMN salary_currency VARCHAR(10),
            ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            ADD COLUMN deleted_at TIMESTAMPTZ;

        UPDATE vacancies SET
            salary_min = NULLIF(salary_range->>'min', '')::numeric,
            salary_max = NULLIF(salary_range->>'max', '')::numeric,
            salary_currency = NULLIF(salary_range->>'currency', '')
        WHERE salary_range IS NOT NULL;

        -- Best-effort link of the legacy free-text creator to a real user
        -- (email or 'First Last' display name). Unmatched → NULL.
        UPDATE vacancies v
        SET created_by_user_id = u.id
        FROM users u
        WHERE v.created_by_user_id IS NULL
          AND v.created_by IS NOT NULL
          AND (
              lower(u.email) = lower(btrim(v.created_by))
              OR lower(u.first_name || ' ' || u.last_name) = lower(btrim(v.created_by))
          );

        UPDATE vacancies SET status = 'Active' WHERE status IS NULL;

        ALTER TABLE vacancies
            DROP COLUMN created_by,
            DROP COLUMN salary_range,
            ADD CONSTRAINT vacancies_salary_check
                CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max),
            ADD CONSTRAINT vacancies_status_check
                CHECK (status IN ('Active', 'Closed', 'Draft', 'Archived')),
            ADD CONSTRAINT vacancies_type_check
                CHECK (type IN ('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship')),
            ADD CONSTRAINT vacancies_experience_level_check
                CHECK (experience_level IN ('Entry Level', 'Mid Level', 'Senior Level', 'Executive'));

        CREATE INDEX idx_vacancies_status ON vacancies(status) WHERE deleted_at IS NULL;
        CREATE INDEX idx_vacancies_type ON vacancies(type);
        CREATE INDEX idx_vacancies_location ON vacancies(location);
        CREATE INDEX idx_vacancies_created_at ON vacancies(created_at DESC);
        CREATE INDEX idx_vacancies_skills_required_gin ON vacancies USING GIN (skills_required);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE vacancies
            DROP CONSTRAINT vacancies_salary_check,
            DROP CONSTRAINT vacancies_status_check,
            DROP CONSTRAINT vacancies_type_check,
            DROP CONSTRAINT vacancies_experience_level_check,
            ADD COLUMN salary_range JSONB,
            ADD COLUMN created_by VARCHAR(255);

        UPDATE vacancies v SET salary_range = jsonb_build_object(
            'min', v.salary_min, 'max', v.salary_max, 'currency', v.salary_currency
        ) WHERE v.salary_min IS NOT NULL OR v.salary_max IS NOT NULL;

        UPDATE vacancies v
        SET created_by = u.first_name || ' ' || u.last_name
        FROM users u WHERE u.id = v.created_by_user_id;
        UPDATE vacancies SET created_by = 'HR Admin' WHERE created_by IS NULL;
        ALTER TABLE vacancies ALTER COLUMN created_by SET NOT NULL;

        DROP INDEX IF EXISTS idx_vacancies_status;
        DROP INDEX IF EXISTS idx_vacancies_type;
        DROP INDEX IF EXISTS idx_vacancies_location;
        DROP INDEX IF EXISTS idx_vacancies_created_at;
        DROP INDEX IF EXISTS idx_vacancies_skills_required_gin;

        ALTER TABLE vacancies
            DROP COLUMN salary_min,
            DROP COLUMN salary_max,
            DROP COLUMN salary_currency,
            DROP COLUMN created_by_user_id,
            DROP COLUMN deleted_at;
    `);
};
