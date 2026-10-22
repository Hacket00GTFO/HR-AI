import { startTracing } from '@strafor/node-common/tracing';
startTracing({ serviceName: 'identity-auth' });

import { logger } from '@strafor/node-common';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { waitForConnection, runMigrations, shutdownDb } from './db.js';
import { shutdownRedis } from './redis.js';
import { shutdownEvents } from './events.js';
import { createServiceRelay } from './outboxRelay.js';

async function main(): Promise<void> {
    const config = loadConfig();
    if (!config.databaseUrl) {
        logger.error('FATAL: DATABASE_URL environment variable is required. See .env.example.');
        process.exit(1);
    }

    const { app } = await createApp(config);

    const server = app.listen(config.port, () => {
        logger.info(`identity-auth listening on port ${config.port}`);
    });

    // Connect + migrate in the background — /health stays up, /ready reports
    // real status while the database is unreachable.
    const outboxRelay = createServiceRelay(config);

    try {
        await waitForConnection();
        await runMigrations(config.databaseUrl);
        logger.info('identity-auth database connected and migrated');
        // Drain outbox_events → RabbitMQ after migrations so the table exists.
        outboxRelay.start();
    } catch (err) {
        logger.error({ err: (err as Error).message }, 'database migration failed');
    }

    const shutdown = (signal: string) => {
        logger.info(`${signal} received — shutting down`);
        server.close(async () => {
            await outboxRelay.stop();
            await shutdownEvents();
            await shutdownRedis();
            await shutdownDb();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
    logger.error({ err: (err as Error).message }, 'fatal boot error');
    process.exit(1);
});
