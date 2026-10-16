const db = require('../db');

// Approval workflow model. A workflow defines the rules for an entity type;
// requests are created against a workflow and resolved via approve/reject.

async function findWorkflows() {
    const { rows } = await db.query('SELECT * FROM approval_workflows ORDER BY created_at DESC');
    return rows.map(db.withId);
}

async function findWorkflowById(id) {
    const { rows } = await db.query('SELECT * FROM approval_workflows WHERE id = $1', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function createWorkflow(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(
        `INSERT INTO approval_workflows (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
    );
    return db.withId(rows[0]);
}

async function updateWorkflow(id, data) {
    const allowed = ['name', 'entity_type', 'rules', 'active'];
    const keys = Object.keys(data).filter((k) => allowed.includes(k) && data[k] !== undefined);
    if (keys.length === 0) return findWorkflowById(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => data[k]);
    const { rows } = await db.query(`UPDATE approval_workflows SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function findPendingRequests() {
    const { rows } = await db.query(
        `SELECT * FROM approval_requests
         WHERE status = 'pending'
         ORDER BY created_at DESC`
    );
    return rows.map(db.withId);
}

async function findRequestById(id) {
    const { rows } = await db.query('SELECT * FROM approval_requests WHERE id = $1', [id]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function createRequest(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(
        `INSERT INTO approval_requests (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
    );
    return db.withId(rows[0]);
}

async function approve(id, userId) {
    const { rows } = await db.query(
        `UPDATE approval_requests
            SET status = 'approved', approved_by = $2, resolved_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, userId]
    );
    return rows[0] ? db.withId(rows[0]) : null;
}

async function reject(id, userId, reason) {
    const { rows } = await db.query(
        `UPDATE approval_requests
            SET status = 'rejected', approved_by = $2,
                rejection_reason = $3, resolved_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, userId, reason]
    );
    return rows[0] ? db.withId(rows[0]) : null;
}

module.exports = {
    findWorkflows,
    findWorkflowById,
    createWorkflow,
    updateWorkflow,
    findPendingRequests,
    findRequestById,
    createRequest,
    approve,
    reject
};
