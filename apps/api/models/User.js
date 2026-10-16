const bcrypt = require('bcryptjs');
const { query, withId } = require('../db');

// DB columns are snake_case; the API wire format keeps the legacy camelCase
// keys (the frontend reads account.firstName / lastName / lastLogin / _id).
const SELECT = `
    SELECT id,
           first_name AS "firstName",
           last_name  AS "lastName",
           email, password, role, location,
           last_login AS "lastLogin",
           logged_out AS "loggedOut",
           active,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
    FROM users
`;

// API field name → DB column. updateById keeps accepting the legacy
// camelCase field names used by routes.
const FIELD_TO_COLUMN = {
    firstName: 'first_name',
    lastName: 'last_name',
    email: 'email',
    password: 'password',
    role: 'role',
    location: 'location',
    lastLogin: 'last_login',
    loggedOut: 'logged_out',
    active: 'active'
};

async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

const User = {
    async findByEmail(email) {
        const { rows } = await query(`${SELECT} WHERE email = $1 AND deleted_at IS NULL`, [email]);
        return withId(rows[0] || null);
    },

    async findById(id, { excludePassword = false } = {}) {
        const { rows } = await query(`${SELECT} WHERE id = $1 AND deleted_at IS NULL`, [id]);
        const user = withId(rows[0] || null);
        if (user && excludePassword) delete user.password;
        return user;
    },

    async findByRole(role, { excludePassword = false } = {}) {
        const { rows } = await query(`${SELECT} WHERE role = $1 AND deleted_at IS NULL ORDER BY last_login DESC`, [
            role
        ]);
        return rows.map((row) => {
            withId(row);
            if (excludePassword) delete row.password;
            return row;
        });
    },

    async create({ firstName, lastName, email, password, role, location }) {
        const hashed = await hashPassword(password);
        const { rows } = await query(
            `INSERT INTO users (first_name, last_name, email, password, role, location)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id,
                       first_name AS "firstName", last_name AS "lastName",
                       email, password, role, location,
                       last_login AS "lastLogin", logged_out AS "loggedOut", active,
                       created_at AS "createdAt", updated_at AS "updatedAt"`,
            [firstName, lastName, email.toLowerCase().trim(), hashed, role, location ? JSON.stringify(location) : null]
        );
        return withId(rows[0]);
    },

    async updateById(id, fields) {
        const updates = { ...fields };
        if (updates.password) {
            updates.password = await hashPassword(updates.password);
        }
        // Filter to whitelisted fields only
        const keys = Object.keys(updates).filter((k) => FIELD_TO_COLUMN[k] && updates[k] !== undefined);
        if (keys.length === 0) return this.findById(id);

        const setClause = keys.map((key, i) => `"${FIELD_TO_COLUMN[key]}" = $${i + 2}`).join(', ');
        const values = keys.map((key) =>
            key === 'location' ? (updates[key] ? JSON.stringify(updates[key]) : null) : updates[key]
        );
        const { rows } = await query(
            `UPDATE users SET ${setClause}, updated_at = now()
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING id,
                       first_name AS "firstName", last_name AS "lastName",
                       email, password, role, location,
                       last_login AS "lastLogin", logged_out AS "loggedOut", active,
                       created_at AS "createdAt", updated_at AS "updatedAt"`,
            [id, ...values]
        );
        return withId(rows[0] || null);
    },

    async deleteById(id) {
        const { rows } = await query(
            `DELETE FROM users WHERE id = $1
             RETURNING id,
                       first_name AS "firstName", last_name AS "lastName",
                       email, role`,
            [id]
        );
        return withId(rows[0] || null);
    },

    async countByRole(role) {
        const { rows } = await query(
            'SELECT COUNT(*)::int AS count FROM users WHERE role = $1 AND deleted_at IS NULL',
            [role]
        );
        return rows[0].count;
    },

    async emailExists(email, excludeId = null) {
        const { rows } = excludeId
            ? await query('SELECT 1 FROM users WHERE email = $1 AND id <> $2 AND deleted_at IS NULL', [
                  email,
                  excludeId
              ])
            : await query('SELECT 1 FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
        return rows.length > 0;
    },

    async comparePassword(plainPassword, hashedPassword) {
        return bcrypt.compare(plainPassword, hashedPassword);
    }
};

module.exports = User;
