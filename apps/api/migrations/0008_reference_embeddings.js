/**
 * 0008_reference_embeddings — reference data + pgvector-ready embedding tables.
 *
 *   countries / states — seeded deterministically from data/countries.js (the
 *     exact same source the routes served before, including generated region
 *     placeholders). After this migration the DB is authoritative.
 *   candidate_embeddings / vacancy_embeddings — vector(1536) slots for the
 *     upcoming ai-matching service. Empty for now.
 */
const { allCountries, getStates } = require('../data/countries');

exports.up = async (pgm) => {
    // pgm.db.query executes immediately (pgm.sql is queued until up() returns),
    // so the seed INSERTs below can rely on these tables existing.
    await pgm.db.query(`
        CREATE TABLE countries (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE states (
            id SERIAL PRIMARY KEY,
            country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
            name VARCHAR(120) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (country_id, name)
        );

        CREATE TABLE candidate_embeddings (
            id BIGSERIAL PRIMARY KEY,
            candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
            model_version VARCHAR(100) NOT NULL,
            embedding vector(1536),
            doc_hash VARCHAR(64),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (candidate_id, model_version)
        );

        CREATE TABLE vacancy_embeddings (
            id BIGSERIAL PRIMARY KEY,
            vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
            model_version VARCHAR(100) NOT NULL,
            embedding vector(1536),
            doc_hash VARCHAR(64),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (vacancy_id, model_version)
        );
    `);

    for (const name of allCountries) {
        const { rows } = await pgm.db.query(
            'INSERT INTO countries (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id',
            [name]
        );
        const countryId = rows[0]
            ? rows[0].id
            : (await pgm.db.query('SELECT id FROM countries WHERE name = $1', [name])).rows[0].id;

        const states = await getStates(name);
        for (const state of states) {
            await pgm.db.query(
                'INSERT INTO states (country_id, name) VALUES ($1, $2) ON CONFLICT (country_id, name) DO NOTHING',
                [countryId, state]
            );
        }
    }
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE vacancy_embeddings;
        DROP TABLE candidate_embeddings;
        DROP TABLE states;
        DROP TABLE countries;
    `);
};
