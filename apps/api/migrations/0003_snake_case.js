/**
 * 0003_snake_case — rename the legacy quoted camelCase columns to snake_case.
 *
 * The API wire format is preserved by the models (SQL aliases / key mapping),
 * so this is invisible to clients.
 */
const RENAMES = [
    ['users', 'firstName', 'first_name'],
    ['users', 'lastName', 'last_name'],
    ['users', 'lastLogin', 'last_login'],
    ['users', 'loggedOut', 'logged_out'],
    ['users', 'createdAt', 'created_at'],
    ['users', 'updatedAt', 'updated_at'],
    ['settings', 'userId', 'user_id'],
    ['settings', 'createdAt', 'created_at'],
    ['settings', 'updatedAt', 'updated_at'],
    ['vacancies', 'createdAt', 'created_at'],
    ['vacancies', 'updatedAt', 'updated_at'],
    ['candidates', 'createdAt', 'created_at'],
    ['candidates', 'updatedAt', 'updated_at']
];

const quote = (name) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`);

exports.up = (pgm) => {
    for (const [table, from, to] of RENAMES) {
        pgm.sql(`ALTER TABLE ${table} RENAME COLUMN ${quote(from)} TO ${quote(to)}`);
    }
};

exports.down = (pgm) => {
    for (const [table, from, to] of [...RENAMES].reverse()) {
        pgm.sql(`ALTER TABLE ${table} RENAME COLUMN ${quote(to)} TO ${quote(from)}`);
    }
};
