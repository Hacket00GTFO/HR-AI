import express, { type Express } from 'express';
import { correlationId, errorHandler, notFound, createMetrics } from '@strafor/node-common';
import { attendanceRouter } from './routes/attendance.js';
import { leaveRouter } from './routes/leave.js';
import { schedulesRouter } from './routes/schedules.js';
import { internalRouter } from './routes/internal.js';
import type { TimeDeps } from './deps.js';

// Metrics bundle — created at module level so route handlers can import
// the domain counters without depending on the Express app.
const metrics = createMetrics({ serviceName: 'time-attendance' });

// Domain metrics.
export const attendanceRecorded = metrics.counter(
    'attendance_events_recorded_total',
    'Total attendance events recorded',
    ['kind']
);
export const leaveDecided = metrics.counter('leave_requests_decided_total', 'Leave requests decided', ['decision']);

export { metrics };

export function createApp(deps: TimeDeps): Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '256kb' }));
    app.use(correlationId);

    // HTTP metrics middleware — after correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'time-attendance' });
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

    // Prometheus scrape — before any auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    app.use('/v1/attendance', attendanceRouter(deps));
    app.use('/v1/leave', leaveRouter(deps));
    app.use('/v1/schedules', schedulesRouter(deps));
    // Service-token-only internal API (DSAR fan-out from the monolith).
    app.use('/v1/internal', internalRouter(deps));
    app.use(notFound);
    app.use(errorHandler);
    return app;
}
