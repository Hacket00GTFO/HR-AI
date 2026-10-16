const db = require('../db');
const logger = require('./logger');

/**
 * Append one row to audit_logs. Best-effort by design — audit failures are
 * logged but never fail the request that triggered them.
 *
 * @param {object} entry
 * @param {number|string|null} entry.actorId  users.id of the actor (req.user.id), null for system
 * @param {string} entry.action               e.g. 'vacancy.create', 'application.status_change'
 * @param {string} entry.entity               table/entity name, e.g. 'vacancies'
 * @param {number|string|null} entry.entityId primary key of the affected row
 * @param {object} [entry.metadata]           arbitrary JSONB payload (redacted keys stay out)
 * @param {object} [entry.client]             pg client to write inside a caller transaction
 */
async function record({ actorId = null, action, entity, entityId = null, metadata = {}, client }) {
    try {
        const q = client || db;
        await q.query(
            `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                actorId != null ? Number(actorId) : null,
                action,
                entity,
                entityId != null ? Number(entityId) : null,
                JSON.stringify(metadata)
            ]
        );
    } catch (err) {
        logger.error('audit_logs write failed:', err.message, { action, entity, entityId });
    }
}

module.exports = { record };
