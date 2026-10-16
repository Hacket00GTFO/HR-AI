const db = require('../db');

// Webhook model. A webhook subscribes to a set of events; each delivery
// attempt is recorded in webhook_deliveries for retry and auditing.

async function find() {
    const { rows } = await db.query('SELECT * FROM webhooks ORDER BY created_at DESC');
    return rows.map(db.withId);
}

async function findById(id) {
    const { rows } = await db.query('SELECT * FROM webhooks WHERE id = $1', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function create(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(`INSERT INTO webhooks (${cols}) VALUES (${placeholders}) RETURNING *`, values);
    return db.withId(rows[0]);
}

async function update(id, data) {
    const allowed = ['url', 'description', 'events', 'active'];
    const keys = Object.keys(data).filter((k) => allowed.includes(k) && data[k] !== undefined);
    if (keys.length === 0) return findById(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => data[k]);
    const { rows } = await db.query(`UPDATE webhooks SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function remove(id) {
    await db.query('DELETE FROM webhooks WHERE id = $1', [id]);
}

async function findDeliveries(webhookId, limit = 50) {
    const { rows } = await db.query(
        `SELECT * FROM webhook_deliveries
         WHERE webhook_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [webhookId, limit]
    );
    return rows.map(db.withId);
}

async function createDelivery(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(
        `INSERT INTO webhook_deliveries (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
    );
    return db.withId(rows[0]);
}

async function updateDelivery(id, data) {
    const allowed = ['status_code', 'response_body', 'attempts', 'status', 'delivered_at'];
    const keys = Object.keys(data).filter((k) => allowed.includes(k) && data[k] !== undefined);
    if (keys.length === 0) return findDeliveryById(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => data[k]);
    const { rows } = await db.query(`UPDATE webhook_deliveries SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function findDeliveryById(id) {
    const { rows } = await db.query('SELECT * FROM webhook_deliveries WHERE id = $1', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

module.exports = {
    find,
    findById,
    create,
    update,
    delete: remove,
    findDeliveries,
    createDelivery,
    updateDelivery,
    findDeliveryById
};
