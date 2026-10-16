const db = require('../db');

// IP allowlist entries control which IPs may access admin/app surfaces.
// CIDR matching uses PostgreSQL's inet/cidr operators (>>=).

async function find() {
    const { rows } = await db.query('SELECT * FROM ip_allowlist ORDER BY created_at DESC');
    return rows.map(db.withId);
}

async function findById(id) {
    const { rows } = await db.query('SELECT * FROM ip_allowlist WHERE id = $1', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function create(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(`INSERT INTO ip_allowlist (${cols}) VALUES (${placeholders}) RETURNING *`, values);
    return db.withId(rows[0]);
}

async function remove(id) {
    const { rows } = await db.query('DELETE FROM ip_allowlist WHERE id = $1 RETURNING *', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

// Returns true if the allowlist is empty (backward compatible) or if the
// given IP matches a CIDR entry for the requested applies_to scope.
async function isAllowed(ip, appliesTo = 'admin') {
    const { rows } = await db.query(
        'SELECT 1 FROM ip_allowlist WHERE applies_to = $1 AND ip_cidr >>= $2::inet LIMIT 1',
        [appliesTo, ip]
    );
    if (rows.length > 0) return true;
    // No matching entry — allow only if the allowlist is empty (open by default).
    const { rows: countRows } = await db.query('SELECT 1 FROM ip_allowlist WHERE applies_to = $1 LIMIT 1', [appliesTo]);
    return countRows.length === 0;
}

module.exports = {
    find,
    findById,
    create,
    delete: remove,
    isAllowed
};
