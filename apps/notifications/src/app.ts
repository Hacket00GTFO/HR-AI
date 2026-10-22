import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { Transporter } from 'nodemailer';
import { correlationId, errorHandler, notFound, type ServiceLogger, createMetrics } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';
import { notificationsRouter } from './routes/notifications.js';

export interface AppDeps {
    pool: Pool;
    transporter: Transporter;
    config: ServiceConfig;
    log: ServiceLogger;
}

// Metrics bundle — created at module level so the worker/mailer can import
// the domain counter without depending on the Express app.
const metrics = createMetrics({ serviceName: 'notifications' });

// Domain metric: notifications sent by channel/template/outcome.
export const notificationsSent = metrics.counter('notifications_sent_total', 'Total notifications sent', [
    'channel',
    'template',
    'outcome'
]);

export { metrics };

export function createApp(deps: AppDeps): Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '256kb' }));
    app.use(correlationId);

    // HTTP metrics middleware — after correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'notifications' });
    });

    app.get('/ready', async (_req, res) => {
        const checks: Record<string, string> = {};
        try {
            await deps.pool.query('SELECT 1');
            checks.db = 'ok';
        } catch {
            checks.db = 'fail';
        }
        try {
            await deps.transporter.verify();
            checks.smtp = 'ok';
        } catch {
            checks.smtp = 'fail';
        }
        const ready = Object.values(checks).every((v) => v === 'ok');
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
    });

    // Prometheus scrape — before any rate limiter/auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    app.use('/v1/notifications', notificationsRouter(deps));
    app.use(notFound);
    app.use(errorHandler);
    return app;
}
