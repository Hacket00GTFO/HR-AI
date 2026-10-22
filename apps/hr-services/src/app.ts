import express, { type Express } from 'express';
import { correlationId, errorHandler, notFound, createMetrics, type ServiceLogger } from '@strafor/node-common';
import type { Pool } from 'pg';
import type { ServiceConfig } from './config.js';
import type { EventPublisher } from './events.js';
import { ticketsRouter } from './routes/tickets.js';
import { assetsRouter } from './routes/assets.js';
import { expensesRouter } from './routes/expenses.js';
import { surveysRouter } from './routes/surveys.js';
import { internalRouter } from './routes/internal.js';

// Metrics bundle — created at module level so route handlers can import
// domain counters without depending on the Express app.
const metrics = createMetrics({ serviceName: 'hr-services' });

// Domain metric: service-desk ticket resolutions.
export const ticketsResolved = metrics.counter(
    'hr_services_tickets_resolved_total',
    'Total service-desk tickets resolved',
    ['priority']
);

export { metrics };

export interface HrServicesDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

export function createApp(deps: HrServicesDeps): Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(correlationId);

    // HTTP metrics middleware — after correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'hr-services' });
    });

    app.get('/ready', async (_req, res) => {
        const checks: Record<string, string> = {};
        try {
            await deps.pool.query('SELECT 1');
            checks.db = 'ok';
        } catch {
            checks.db = 'fail';
        }
        const ready = Object.values(checks).every((v) => v === 'ok');
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
    });

    // Prometheus scrape — before any rate limiter/auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    // Canonical mounts — the gateway routes /api/v1/{tickets,assets,expenses,surveys}/* here.
    app.use('/v1/tickets', ticketsRouter(deps));
    app.use('/v1/assets', assetsRouter(deps));
    app.use('/v1/expenses', expensesRouter(deps));
    app.use('/v1/surveys', surveysRouter(deps));

    // Service-token-only internal API (employee_directory upserts).
    app.use('/v1/internal', internalRouter(deps));

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
