import express, { type Express } from 'express';
import { correlationId, errorHandler, notFound, createMetrics, type ServiceLogger } from '@strafor/node-common';
import type { Pool } from 'pg';
import type { ServiceConfig } from './config.js';
import type { EventPublisher } from './events.js';
import { createProvider, type CalendarProvider } from './provider.js';
import { calendarRouter } from './routes/calendar.js';

// Metrics bundle — created at module level so route handlers can import
// domain counters without depending on the Express app.
const metrics = createMetrics({ serviceName: 'calendar-bridge' });

// Domain metrics: calendar event lifecycle by upstream provider.
export const calendarEventsCreated = metrics.counter(
    'calendar_bridge_events_created_total',
    'Total calendar events created',
    ['provider']
);
export const calendarEventsCancelled = metrics.counter(
    'calendar_bridge_events_cancelled_total',
    'Total calendar events cancelled',
    ['provider']
);

export { metrics };

export interface CalendarBridgeDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
    /** Injectable — defaults to createProvider(config). */
    provider?: CalendarProvider;
}

export function createApp(deps: CalendarBridgeDeps): Express {
    const provider = deps.provider ?? createProvider(deps.config, { log: deps.log });
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(correlationId);

    // HTTP metrics middleware — after correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'calendar-bridge' });
    });

    app.get('/ready', async (_req, res) => {
        const checks: Record<string, string> = {};
        try {
            await deps.pool.query('SELECT 1');
            checks.db = 'ok';
        } catch {
            checks.db = 'fail';
        }
        // Informational only — 'stub' is a valid ready state (no M365
        // credentials configured). Never contains credential material.
        checks.provider = provider.mode;
        const ready = checks.db === 'ok';
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
    });

    // Prometheus scrape — before any rate limiter/auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    // Canonical mount — internal API for recruitment-core (interview
    // scheduling) and, later, the employee portal.
    app.use('/v1/calendar', calendarRouter({ ...deps, provider }));

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
