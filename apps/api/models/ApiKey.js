const db = require('../db');

// API key model. Keys are stored hashed (key_hash); the plaintext is only
// shown once at creation time. Revocation is a soft state (revoked_at) so the
// audit trail is preserved.

// Revoked keys stay hidden by default (least-surprise); pass
// includeRevoked=true for audit-style views that need the full history.
async function find({ includeRevoked = false } = {}) {
    const { rows } = await db.query(
        `SELECT id, name, key_prefix, scopes, expires_at, last_used_at,
                created_by, created_at, revoked_at
         FROM api_keys
         ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
         ORDER BY created_at DESC`
    );
    return rows.map(db.withId);
}

async function findById(id) {
    const { rows } = await db.query(
        `SELECT id, name, key_prefix, scopes, expires_at, last_used_at,
                created_by, created_at, revoked_at
         FROM api_keys
         WHERE id = $1`,
        [id]
    );
    return rows[0] ? db.withId(rows[0]) : null;
}

async function create(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(`INSERT INTO api_keys (${cols}) VALUES (${placeholders}) RETURNING *`, values);
    return db.withId(rows[0]);
}

async function updateLastUsed(id) {
    await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
}

async function revoke(id) {
    const { rows } = await db.query(
        `UPDATE api_keys SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING *`,
        [id]
    );
    return rows[0] ? db.withId(rows[0]) : null;
}

async function findByHash(hash) {
    const { rows } = await db.query(
        `SELECT * FROM api_keys
         WHERE key_hash = $1 AND revoked_at IS NULL`,
        [hash]
    );
    return rows[0] ? db.withId(rows[0]) : null;
}

module.exports = {
    find,
    findById,
    create,
    updateLastUsed,
    revoke,
    findByHash
};
