const db = require('../db');

// Feature flag model. Flags are keyed by a unique string. A flag is
// considered "on" for a caller when it is enabled and the caller falls
// within the rollout_percentage bucket (0-100, checked against a random
// number so the same caller is not consistently gated in/out).

async function find() {
    const { rows } = await db.query('SELECT * FROM feature_flags ORDER BY key ASC');
    return rows.map(db.withId);
}

async function findByKey(key) {
    const { rows } = await db.query('SELECT * FROM feature_flags WHERE key = $1', [key]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function create(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(`INSERT INTO feature_flags (${cols}) VALUES (${placeholders}) RETURNING *`, values);
    return db.withId(rows[0]);
}

async function update(key, data, userId) {
    const allowed = ['enabled', 'rollout_percentage', 'description'];
    const keys = Object.keys(data).filter((k) => allowed.includes(k) && data[k] !== undefined);
    if (keys.length === 0) return findByKey(key);
    const sets = ['updated_at = now()', 'updated_by = $2'];
    const values = [key, userId];
    for (const k of keys) {
        values.push(data[k]);
        sets.push(`${k} = $${values.length}`);
    }
    const { rows } = await db.query(`UPDATE feature_flags SET ${sets.join(', ')} WHERE key = $1 RETURNING *`, values);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function isEnabled(key) {
    const flag = await findByKey(key);
    if (!flag || !flag.enabled) return false;
    const rollout = flag.rollout_percentage ?? 0;
    if (rollout >= 100) return true;
    if (rollout <= 0) return false;
    return Math.random() * 100 < rollout;
}

module.exports = {
    find,
    findByKey,
    create,
    update,
    isEnabled
};
