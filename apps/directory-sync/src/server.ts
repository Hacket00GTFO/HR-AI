import 'dotenv/config';
import { startTracing } from '@strafor/node-common/tracing';
startTracing({ serviceName: 'directory-sync' });

import { Pool } from 'pg';
import { createLogger } from '@strafor/node-common';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { runSyncCycle } from './sync.js';
import { createWorker } from './worker.js';
import { syncMetrics } from './metrics.js';

async function main() {
    const config = loadConfig();
    process.env.SERVICE_NAME = config.SERVICE_NAME;
    const log = createLogger();

    // Read-only pool on the identity database — the sync source.
    const pool = new Pool({
        connectionString: config.IDENTITY_DATABASE_URL,
        max: Number(process.env.PG_POOL_MAX || 4),
        idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
        connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 5_000)
    });

    const worker = createWorker({
        intervalMs: config.SYNC_INTERVAL_MS,
        run: () => runSyncCycle({ pool, config, log, metrics: syncMetrics }),
        log
    });
    worker.start();

    const app = createApp({ pool, config, workerState: () => worker.state });
    const server = app.listen(config.PORT, () => {
        log.info({ port: config.PORT, intervalMs: config.SYNC_INTERVAL_MS }, 'directory-sync listening');
    });

    const shutdown = (signal: string) => {
        log.info({ signal }, 'shutting down');
        worker.stop();
        server.close(async () => {
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
