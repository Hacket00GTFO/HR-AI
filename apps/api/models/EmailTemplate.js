const db = require('../db');

// Email template model. Templates are keyed by a unique `name`; every update
// increments `version` and writes a snapshot row to email_template_versions so
// the full history is preserved.

async function find() {
    const { rows } = await db.query('SELECT * FROM email_templates ORDER BY name ASC');
    return rows.map(db.withId);
}

async function findByName(name) {
    const { rows } = await db.query('SELECT * FROM email_templates WHERE name = $1', [name]);
    return rows[0] ? db.withId(rows[0]) : null;
}

async function create(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const { rows } = await db.query(
        `INSERT INTO email_templates (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
    );
    return db.withId(rows[0]);
}

async function update(name, data, userId) {
    return db.withTransaction(async (client) => {
        // Lock the row and read the current version so we can snapshot it.
        const current = await client.query('SELECT * FROM email_templates WHERE name = $1 FOR UPDATE', [name]);
        if (!current.rows[0]) return null;
        const existing = current.rows[0];

        const keys = Object.keys(data).filter((k) => data[k] !== undefined);
        const sets = ['version = version + 1', 'updated_at = now()'];
        const values = [name];
        for (const key of keys) {
            values.push(data[key]);
            sets.push(`${key} = $${values.length}`);
        }

        const updated = await client.query(
            `UPDATE email_templates SET ${sets.join(', ')} WHERE name = $1 RETURNING *`,
            values
        );
        const template = updated.rows[0];

        // Snapshot the previous version for history.
        await client.query(
            `INSERT INTO email_template_versions
                (template_id, version, subject, html_body, text_body, changed_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [existing.id, existing.version, existing.subject, existing.html_body, existing.text_body, userId]
        );

        return db.withId(template);
    });
}

async function getVersions(name) {
    const { rows } = await db.query(
        `SELECT v.* FROM email_template_versions v
         JOIN email_templates t ON t.id = v.template_id
         WHERE t.name = $1
         ORDER BY v.version DESC`,
        [name]
    );
    return rows.map(db.withId);
}

module.exports = {
    find,
    findByName,
    create,
    update,
    getVersions
};
