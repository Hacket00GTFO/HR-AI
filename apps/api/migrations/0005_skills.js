/**
 * 0005_skills — normalized skills tables.
 *
 *   skills          — canonical skill names (lowercase, unique) + ESCO URI slot
 *   candidate_skills— candidate ↔ skill join
 *   vacancy_skills  — vacancy ↔ skill join (+ required flag)
 *
 * Backfilled by splitting candidates.skills (CSV) and vacancies.skills_required
 * (text[]). The raw text columns are KEPT — the legacy JS matcher still reads
 * them; models dual-write until the matcher is replaced.
 */
exports.up = (pgm) => {
    pgm.sql(`
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

        INSERT INTO skills (name)
        SELECT DISTINCT lower(btrim(s)) FROM (
            SELECT unnest(string_to_array(skills, ',')) AS s
            FROM candidates WHERE skills IS NOT NULL
            UNION
            SELECT unnest(skills_required) AS s
            FROM vacancies WHERE skills_required IS NOT NULL
        ) t
        WHERE btrim(s) <> ''
        ON CONFLICT (name) DO NOTHING;

        INSERT INTO candidate_skills (candidate_id, skill_id)
        SELECT DISTINCT c.id, sk.id
        FROM candidates c
        CROSS JOIN LATERAL unnest(string_to_array(c.skills, ',')) AS s
        JOIN skills sk ON sk.name = lower(btrim(s))
        WHERE btrim(s) <> ''
        ON CONFLICT DO NOTHING;

        INSERT INTO vacancy_skills (vacancy_id, skill_id, required)
        SELECT DISTINCT v.id, sk.id, TRUE
        FROM vacancies v
        CROSS JOIN LATERAL unnest(v.skills_required) AS s
        JOIN skills sk ON sk.name = lower(btrim(s))
        WHERE btrim(s) <> ''
        ON CONFLICT DO NOTHING;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE vacancy_skills;
        DROP TABLE candidate_skills;
        DROP TABLE skills;
    `);
};
