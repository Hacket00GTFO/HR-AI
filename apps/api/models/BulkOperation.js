const db = require('../db');

// Tracks long-running bulk operations (import/export/etc). Each row records
// progress as the job is processed so the UI can poll for status.

async function find(limit = 50) {
    const { rows } = await db.query('SELECT * FROM bulk_operations ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows.map(db.withId);
}

async function findById(id) {
    const { rows } = await db.query('SELECT * FROM bulk_operations WHERE id = $1', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function create(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(
        `INSERT INTO bulk_operations (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
    );
    return db.withId(rows[0]);
}

async function updateProgress(id, data) {
    const fields = {
        processed_records: data.processed_records,
        failed_records: data.failed_records,
        status: data.status,
        result_url: data.result_url,
        completed_at: data.completed_at
    };
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (keys.length === 0) return findById(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => fields[k]);
    const { rows } = await db.query(`UPDATE bulk_operations SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
    return rows[0] ? db.withId(rows[0]) : null;
}

module.exports = { find, findById, create, updateProgress };
