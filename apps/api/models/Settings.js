const { query, withId } = require('../db');

const Settings = {
    async findFirst() {
        const { rows } = await query('SELECT * FROM settings ORDER BY id LIMIT 1');
        return withId(rows[0] || null);
    },

    async findByUserId(userId) {
        const { rows } = await query('SELECT * FROM settings WHERE user_id = $1', [Number(userId)]);
        return withId(rows[0] || null);
    },

    async upsertCompany(userId, company) {
        const { rows } = await query(
            `INSERT INTO settings (user_id, company)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET company = EXCLUDED.company, updated_at = now()
             RETURNING *`,
            [Number(userId), JSON.stringify(company)]
        );
        return withId(rows[0]);
    },

    async setLinkedin(linkedin) {
        // Upsert into the first settings row: UPDATE if exists, INSERT otherwise (single query)
        const { rows } = await query(
            `WITH existing AS (SELECT id FROM settings ORDER BY id LIMIT 1),
             upd AS (
                 UPDATE settings SET linkedin = $1, updated_at = now()
                 WHERE id = (SELECT id FROM existing)
                 RETURNING *
             ),
             ins AS (
                 INSERT INTO settings (linkedin)
                 SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM upd)
                 RETURNING *
             )
             SELECT * FROM upd UNION ALL SELECT * FROM ins`,
            [JSON.stringify(linkedin)]
        );
        return withId(rows[0]);
    },

    async setOcc(occ) {
        const { rows } = await query(
            `WITH existing AS (SELECT id FROM settings ORDER BY id LIMIT 1),
             upd AS (
                 UPDATE settings SET occ = $1, updated_at = now()
                 WHERE id = (SELECT id FROM existing)
                 RETURNING *
             ),
             ins AS (
                 INSERT INTO settings (occ)
                 SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM upd)
                 RETURNING *
             )
             SELECT * FROM upd UNION ALL SELECT * FROM ins`,
            [JSON.stringify(occ)]
        );
        return withId(rows[0]);
    }
};

module.exports = Settings;
