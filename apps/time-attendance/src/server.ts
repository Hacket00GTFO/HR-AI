import 'dotenv/config';
import { startTracing } from '@strafor/node-common/tracing';
startTracing({ serviceName: 'time-attendance' });

import path from 'node:path';
import { runner } from 'node-pg-migrate';
import { createLogger } from '@strafor/node-common';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createPublisher } from './events.js';
import { createApp } from './app.js';

// dist/server.js → service root is one level up; src/server.ts is too.
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
    const config = loadConfig();
    process.env.SERVICE_NAME = config.SERVICE_NAME;
    const log = createLogger();

    const pool = createPool(config.DATABASE_URL);

    // Schema first — the service owns its database.
    await runner({
        databaseUrl: config.DATABASE_URL,
        dir: MIGRATIONS_DIR,
        direction: 'up',
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
        schema: 'public',
        count: Infinity,
        log: (msg: string) => log.info(msg)
    });

    const publisher = createPublisher(config.RABBITMQ_URL, config.RABBITMQ_EXCHANGE, log);
    const app = createApp({ pool, config, publisher, log });

    const server = app.listen(config.PORT, () => {
        log.info({ port: config.PORT }, 'time-attendance listening');
    });

    const shutdown = (signal: string) => {
        log.info({ signal }, 'shutting down');
        server.close(async () => {
            await publisher.close();
            await pool.end();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
    // The logger may not be ready at boot — fall back to stderr.
    console.error('Fatal boot error:', err);
    process.exit(1);
});
