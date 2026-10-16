/**
 * 0002_extensions — Postgres extensions required by the normalized schema.
 *
 *   vector   — pgvector: embeddings for the upcoming AI-matching service.
 *              Requires the pgvector/pgvector image (stock postgres lacks it).
 *   pg_trgm  — trigram indexes for ILIKE search (vacancy/candidate search).
 *   unaccent — accent-insensitive text normalization (ES locales).
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE EXTENSION IF NOT EXISTS unaccent;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP EXTENSION IF EXISTS vector;
        DROP EXTENSION IF EXISTS pg_trgm;
        DROP EXTENSION IF EXISTS unaccent;
    `);
};
