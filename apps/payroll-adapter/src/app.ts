import express, { type Express } from 'express';
import { correlationId, errorHandler, notFound, createMetrics, type ServiceLogger } from '@strafor/node-common';
import type { Pool } from 'pg';
import type { ServiceConfig } from './config.js';
import type { EventPublisher } from './events.js';
import { periodsRouter } from './routes/periods.js';
import { fiscalRouter } from './routes/fiscal.js';
import { providersRouter } from './routes/providers.js';
import { internalRouter } from './routes/internal.js';

// Metrics bundle — created at module level so route handlers can import
// domain counters without depending on the Express app.
const metrics = createMetrics({ serviceName: 'payroll-adapter' });

// Domain metrics: provider imports + reconciliation deltas.
export const payrollItemsImported = metrics.counter(
    'payroll_items_imported_total',
    'Total payroll items imported from providers',
    ['provider']
);
export const payrollReconDeltas = metrics.counter(
    'payroll_reconciliation_deltas_total',
    'Total shadow-mode reconciliation deltas recorded'
);

export { metrics };

export interface PayrollDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

export function createApp(deps: PayrollDeps): Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(correlationId);

    // HTTP metrics middleware — after correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'payroll-adapter' });
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

    app.use('/v1/payroll/periods', periodsRouter(deps));
    app.use('/v1/payroll/fiscal', fiscalRouter(deps));
    app.use('/v1/payroll/providers', providersRouter(deps));
    // Service-token-only internal API (DSAR fan-out from the monolith).
    app.use('/v1/internal', internalRouter(deps));

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
