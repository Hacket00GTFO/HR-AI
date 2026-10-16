const db = require('../db');

// Branding is a singleton row (id = 1). There is only ever one configuration,
// so `get` returns it directly and `update` mutates that single row.

async function get() {
    const { rows } = await db.query('SELECT * FROM branding_config WHERE id = 1');
    return rows[0] ? db.withId(rows[0]) : null;
}

async function update(data, userId) {
    const fields = {
        logo_url: data.logo_url,
        primary_color: data.primary_color,
        secondary_color: data.secondary_color,
        font_family: data.font_family,
        custom_domain: data.custom_domain,
        custom_css: data.custom_css,
        updated_by: userId,
        updated_at: new Date()
    };
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map((k) => fields[k]);
    const { rows } = await db.query(`UPDATE branding_config SET ${sets} WHERE id = 1 RETURNING *`, values);
    return rows[0] ? db.withId(rows[0]) : null;
}

module.exports = { get, update };
