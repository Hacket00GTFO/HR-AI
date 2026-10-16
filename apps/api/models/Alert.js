// Alert model — stores alerts received from Alertmanager via webhook.
// Keyed by Alertmanager fingerprint for idempotent upserts.
const db = require('../db');
const logger = require('../utils/logger');

/**
 * Upsert an alert from an Alertmanager webhook payload.
 * @param {object} alert — Alertmanager alert object
 * @param {string} alert.fingerprint
 * @param {string} alert.status — firing | resolved
 * @param {object} alert.labels
 * @param {object} alert.annotations
 * @param {string} alert.startsAt
 * @param {string} alert.endsAt
 * @param {string} alert.generatorURL
 */
async function upsertFromAlertmanager(alert) {
    const fingerprint = alert.fingerprint;
    const alertname = alert.labels?.alertname || 'unknown';
    const severity = alert.labels?.severity || 'info';
    const service = alert.labels?.service || null;
    const container = alert.labels?.container || null;
    const status = alert.status || 'firing';
    const startsAt = alert.startsAt ? new Date(alert.startsAt) : new Date();
    const endsAt = alert.endsAt && alert.endsAt !== '0001-01-01T00:00:00Z' ? new Date(alert.endsAt) : null;
    const summary = alert.annotations?.summary || '';
    const description = alert.annotations?.description || '';
    const labels = JSON.stringify(alert.labels || {});
    const annotations = JSON.stringify(alert.annotations || {});
    const generatorUrl = alert.generatorURL || '';

    const query = `
        INSERT INTO alerts (fingerprint, alertname, severity, service, container, status,
                           starts_at, ends_at, summary, description, labels, annotations, generator_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (fingerprint) DO UPDATE SET
            status = EXCLUDED.status,
            ends_at = EXCLUDED.ends_at,
            annotations = EXCLUDED.annotations,
            updated_at = NOW()
        RETURNING id, status
    `;

    const result = await db.query(query, [
        fingerprint,
        alertname,
        severity,
        service,
        container,
        status,
        startsAt,
        endsAt,
        summary,
        description,
        labels,
        annotations,
        generatorUrl
    ]);
    return result.rows[0];
}

/**
 * Find alerts with optional filters.
 * @param {{ status?: string, severity?: string, service?: string, limit?: number, offset?: number }} opts
 */
async function find(opts = {}) {
    const limit = Math.min(opts.limit || 50, 200);
    const offset = opts.offset || 0;
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (opts.status) {
        conditions.push(`status = $${paramIdx++}`);
        params.push(opts.status);
    }
    if (opts.severity) {
        conditions.push(`severity = $${paramIdx++}`);
        params.push(opts.severity);
    }
    if (opts.service) {
        conditions.push(`service = $${paramIdx++}`);
        params.push(opts.service);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const query = `
        SELECT id, fingerprint, alertname, severity, service, container, status,
               starts_at, ends_at, summary, description, labels, annotations,
               generator_url, acknowledged_by, acknowledged_at, created_at, updated_at
        FROM alerts
        ${where}
        ORDER BY starts_at DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;

    const result = await db.query(query, params);
    return result.rows;
}

/**
 * Count alerts by status.
 */
async function countByStatus() {
    const result = await db.query(`
        SELECT
            COUNT(*) FILTER (WHERE status = 'firing') AS firing,
            COUNT(*) FILTER (WHERE status = 'firing' AND severity = 'critical') AS critical,
            COUNT(*) FILTER (WHERE status = 'firing' AND severity = 'warning') AS warning
        FROM alerts
    `);
    return result.rows[0] || { firing: 0, critical: 0, warning: 0 };
}

/**
 * Acknowledge an alert.
 * @param {number} id
 * @param {number} userId
 */
async function acknowledge(id, userId) {
    const result = await db.query(
        'UPDATE alerts SET acknowledged_by = $2, acknowledged_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
        [id, userId]
    );
    return result.rows[0];
}

/**
 * Find an alert by ID.
 */
async function findById(id) {
    const result = await db.query('SELECT * FROM alerts WHERE id = $1', [id]);
    return result.rows[0];
}

module.exports = {
    upsertFromAlertmanager,
    find,
    countByStatus,
    acknowledge,
    findById
};
