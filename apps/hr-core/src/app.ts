import express, { type Express } from 'express';
import { correlationId, errorHandler, notFound, createMetrics, type ServiceLogger } from '@strafor/node-common';
import type { Pool } from 'pg';
import type { ServiceConfig } from './config.js';
import type { EventPublisher } from './events.js';
import { employeesRouter } from './routes/employees.js';
import { departmentsRouter } from './routes/departments.js';
import { orgRouter } from './routes/org.js';
import { onboardingRouter } from './routes/onboarding.js';
import { workflowsRouter } from './routes/workflows.js';
import { internalRouter } from './routes/internal.js';

// Metrics bundle — created at module level so route handlers can import
// domain counters without depending on the Express app.
const metrics = createMetrics({ serviceName: 'hr-core' });

// Domain metric: onboarding case transitions.
export const onboardingCasesCompleted = metrics.counter(
    'hr_onboarding_cases_completed_total',
    'Total onboarding/offboarding cases completed',
    ['type']
);

export { metrics };

export interface HrCoreDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

export function createApp(deps: HrCoreDeps): Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(correlationId);

    // HTTP metrics middleware — after correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'hr-core' });
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

    // Canonical mounts.
    app.use('/v1/employees', employeesRouter(deps));
    app.use('/v1/departments', departmentsRouter(deps));
    app.use('/v1/org', orgRouter(deps));
    app.use('/v1/onboarding', onboardingRouter(deps));

    // Gateway aliases — the gateway routes /api/v1/{employees,hr,org}/* to
    // this service, so departments and onboarding are also reachable under
    // the org/hr prefixes (/api/v1/org/departments, /api/v1/hr/onboarding).
    app.use('/v1/org/departments', departmentsRouter(deps));
    app.use('/v1/hr/onboarding', onboardingRouter(deps));

    // Service-token-only internal API (users_projection upserts).
    app.use('/v1/internal', internalRouter(deps));

    // Interdepartmental workflow layer — mounted at /v1 so it can own
    // /workflow-templates, /workflows, /workflow-tasks and the nested
    // /employees/:id/workflows paths (the employees router's single-segment
    // /:id patterns never match the two-segment workflows path).
    app.use('/v1', workflowsRouter(deps));

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
