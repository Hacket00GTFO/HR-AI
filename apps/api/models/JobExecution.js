const db = require('../db');

const TABLE = 'job_executions';

const JobExecution = {
    async find(filters = {}) {
        const where = ['TRUE'];
        const params = [];

        if (filters.status != null && filters.status !== '') {
            params.push(filters.status);
            where.push(`status = $${params.length}`);
        }
        if (filters.queue != null && filters.queue !== '') {
            params.push(filters.queue);
            where.push(`queue = $${params.length}`);
        }

        const limit = filters.limit != null ? Number(filters.limit) : 50;
        const offset = filters.offset != null ? Number(filters.offset) : 0;
        params.push(limit, offset);

        const { rows } = await db.query(
            `SELECT * FROM ${TABLE} WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        return rows.map(db.withId);
    },

    async findById(id) {
        const { rows } = await db.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
        return rows[0] ? db.withId(rows[0]) : null;
    },

    async create(data) {
        const keys = Object.keys(data).filter((k) => data[k] !== undefined);
        const values = keys.map((k) => data[k]);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const cols = keys.join(', ');
        const { rows } = await db.query(`INSERT INTO ${TABLE} (${cols}) VALUES (${placeholders}) RETURNING *`, values);
        return db.withId(rows[0]);
    },

    async updateStatus(id, status, extra = {}) {
        const sets = ['status = $2'];
        const values = [id, status];

        const optional = ['started_at', 'completed_at', 'error', 'attempts'];
        for (const key of optional) {
            if (extra[key] !== undefined) {
                values.push(extra[key]);
                sets.push(`${key} = $${values.length}`);
            }
        }

        const { rows } = await db.query(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values);
        return rows[0] ? db.withId(rows[0]) : null;
    },

    async stats() {
        const { rows } = await db.query(
            `SELECT
                COUNT(*)::integer AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
                COUNT(*) FILTER (WHERE status = 'running')::integer AS running,
                COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed,
                COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed
             FROM ${TABLE}`
        );
        const totals = rows[0] || { total: 0, pending: 0, running: 0, completed: 0, failed: 0 };

        const { rows: queueRows } = await db.query(
            `SELECT queue, COUNT(*)::integer AS count FROM ${TABLE} GROUP BY queue ORDER BY count DESC`
        );

        return { ...totals, byQueue: queueRows };
    }
};

module.exports = JobExecution;
