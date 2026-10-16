require('dotenv').config();
const path = require('path');
const { runner } = require('node-pg-migrate');

/**
 * Thin wrapper over node-pg-migrate so CLI runs load .env exactly like the app.
 *
 *   node scripts/migrate.js up [migrationName] [--fake]
 *   node scripts/migrate.js down [migrationName]
 *
 * Equivalent bare-CLI usage also works (DATABASE_URL + migrations/ defaults):
 *   pnpm --filter @strafor/api exec node-pg-migrate up
 */

const direction = process.argv[2] === 'down' ? 'down' : 'up';
const positional = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const fake = process.argv.includes('--fake');

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is required. See .env.example.');
    process.exit(1);
}

runner({
    databaseUrl: process.env.DATABASE_URL,
    dir: path.join(__dirname, '..', 'migrations'),
    direction,
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'public',
    schema: 'public',
    // `down` defaults to the single most recent migration (node-pg-migrate
    // CLI semantics); `up` runs everything pending. A numeric arg = count,
    // a name = run up/down to that migration file.
    count: positional[0] && /^\d+$/.test(positional[0]) ? Number(positional[0]) : direction === 'down' ? 1 : Infinity,
    file: positional[0] && !/^\d+$/.test(positional[0]) ? positional[0] : undefined,
    fake,
    log: (msg) => console.log(msg)
})
    .then((migrations) => {
        if (!migrations || migrations.length === 0) {
            console.log('No migrations to run.');
        }
        process.exit(0);
    })
    .catch((err) => {
        console.error('Migration failed:', err.message || err);
        process.exit(1);
    });
