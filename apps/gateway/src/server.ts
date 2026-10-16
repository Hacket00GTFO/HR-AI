import { startTracing } from '@strafor/node-common/tracing';
startTracing({ serviceName: 'gateway' });

import { logger } from '@strafor/node-common';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { shutdownRedis } from './redis.js';

function main(): void {
    const config = loadConfig();
    const app = createApp(config);

    const server = app.listen(config.port, () => {
        logger.info(
            {
                port: config.port,
                api: config.apiUrl,
                identity: config.identityUrl,
                jwks: config.identityJwksUrl
            },
            'gateway listening'
        );
    });

    const shutdown = (signal: string) => {
        logger.info(`${signal} received — shutting down`);
        server.close(async () => {
            await shutdownRedis();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
