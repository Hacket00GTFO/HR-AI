/**
 * 0001_documents — documents-resumes service schema.
 *
 *   documents       hot row: metadata + status; extracted text lives separately
 *   document_texts  extracted plain text (1:1, kept out of the hot row)
 *   jobs            lightweight pg-backed job queue (parse, async S3 deletes)
 *
 * sha256 uses a PARTIAL unique index (live rows only) so a deleted document
 * does not block re-uploading the same content.
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            owner_candidate_id INTEGER,
            kind VARCHAR(40) NOT NULL DEFAULT 'resume',
            original_name VARCHAR(500) NOT NULL,
            mime VARCHAR(200) NOT NULL,
            size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
            sha256 CHAR(64) NOT NULL,
            s3_key VARCHAR(1024) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'uploaded'
                CHECK (status IN ('uploaded', 'parsing', 'parsed', 'failed')),
            parse_version VARCHAR(40),
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        );

        CREATE UNIQUE INDEX documents_sha256_live_uidx
            ON documents (sha256) WHERE deleted_at IS NULL;
        CREATE UNIQUE INDEX documents_s3_key_uidx ON documents (s3_key);
        CREATE INDEX documents_owner_idx
            ON documents (owner_candidate_id) WHERE deleted_at IS NULL;

        CREATE TABLE document_texts (
            document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            extracted_text TEXT NOT NULL,
            page_count INTEGER,
            extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE jobs (
            id BIGSERIAL PRIMARY KEY,
            type VARCHAR(60) NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}',
            status VARCHAR(20) NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'done', 'failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX jobs_poll_idx ON jobs (run_at) WHERE status = 'queued';
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE jobs;
        DROP TABLE document_texts;
        DROP TABLE documents;
    `);
};
