const db = require('../db');

// Data retention policies and DSAR (data subject access requests) tracking.

async function findPolicies() {
    const { rows } = await db.query('SELECT * FROM data_retention_policies ORDER BY entity_type');
    return rows.map(db.withId);
}

async function findPolicyById(id) {
    const { rows } = await db.query('SELECT * FROM data_retention_policies WHERE id = $1', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function createPolicy(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(
        `INSERT INTO data_retention_policies (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
    );
    return db.withId(rows[0]);
}

async function updatePolicy(id, data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    if (keys.length === 0) return findPolicyById(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => data[k]);
    const { rows } = await db.query(`UPDATE data_retention_policies SET ${sets} WHERE id = $1 RETURNING *`, [
        id,
        ...values
    ]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function deletePolicy(id) {
    const { rows } = await db.query('DELETE FROM data_retention_policies WHERE id = $1 RETURNING *', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function findDsars() {
    const { rows } = await db.query('SELECT * FROM data_subject_requests ORDER BY created_at DESC');
    return rows.map(db.withId);
}

async function findDsarById(id) {
    const { rows } = await db.query('SELECT * FROM data_subject_requests WHERE id = $1', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function createDsar(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(
        `INSERT INTO data_subject_requests (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
    );
    return db.withId(rows[0]);
}

async function updateDsarStatus(id, status, resultUrl) {
    const { rows } = await db.query(
        'UPDATE data_subject_requests SET status = $2, result_url = $3 WHERE id = $1 RETURNING *',
        [id, status, resultUrl]
    );
    return rows[0] ? db.withId(rows[0]) : null;
}

// Generic partial update for a DSAR row. Stamps completed_at automatically
// when the status transitions to 'completed'.
async function updateDsar(id, data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    if (keys.length === 0) return findDsarById(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    if (data.status === 'completed') {
        sets.push('completed_at = now()');
    }
    const values = keys.map((k) => data[k]);
    const { rows } = await db.query(`UPDATE data_subject_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [
        id,
        ...values
    ]);
    return rows[0] ? db.withId(rows[0]) : null;
}

module.exports = {
    findPolicies,
    findPolicyById,
    createPolicy,
    updatePolicy,
    deletePolicy,
    findDsars,
    findDsarById,
    createDsar,
    updateDsarStatus,
    updateDsar
};
