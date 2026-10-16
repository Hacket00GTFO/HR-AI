/**
 * 0002_sha256_dedupe_scope — privacy audit H6.
 *
 * sha256 dedupe is scoped per owner, not global: identical bytes uploaded for
 * a different candidate must produce a NEW document row (never reveal the
 * foreign row's id/owner/name). The old partial unique index on sha256 alone
 * made same-hash rows impossible across owners; replace it with a composite
 * (sha256, owner) index where NULL owners share scope 0.
 *
 * documents_s3_key_uidx is untouched: every row keeps its own s3_key
 * (documents/<uuid>/<name>), so deleting one row never orphans another row's
 * object — no shared-key reference counting needed.
 */
exports.up = (pgm) => {
    pgm.sql(`
        DROP INDEX documents_sha256_live_uidx;

        CREATE UNIQUE INDEX documents_sha256_owner_live_uidx
            ON documents (sha256, COALESCE(owner_candidate_id, 0))
            WHERE deleted_at IS NULL;
    `);
};

exports.down = (pgm) => {
    // Fails (by design) if two live rows share a sha256 across owners —
    // that data cannot be represented under the old global index.
    pgm.sql(`
        DROP INDEX documents_sha256_owner_live_uidx;

        CREATE UNIQUE INDEX documents_sha256_live_uidx
            ON documents (sha256) WHERE deleted_at IS NULL;
    `);
};
