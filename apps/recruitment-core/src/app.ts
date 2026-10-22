import express, { type Express } from 'express';
import { correlationId, errorHandler, notFound, createMetrics } from '@strafor/node-common';
import { vacanciesRouter } from './routes/vacancies.js';
import { candidatesRouter } from './routes/candidates.js';
import { applicationsRouter } from './routes/applications.js';
import { interviewsRouter } from './routes/interviews.js';
import { offersRouter } from './routes/offers.js';
import { publicRouter } from './routes/public.js';
import { aiRouter } from './routes/ai.js';
import { internalRouter } from './routes/internal.js';
import type { ServiceDeps } from './deps.js';

// Metrics bundle — created at module level like documents-resumes so route
// handlers could import domain counters without depending on the app.
const metrics = createMetrics({ serviceName: 'recruitment-core' });

export { metrics };

export function createApp(deps: ServiceDeps): Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    // urlencoded: the monolith parsed form posts too (server.js); multipart
    // resume uploads are handled by multer in the routers.
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    app.use(correlationId);

    // HTTP metrics middleware — after correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'recruitment-core' });
    });

    app.get('/ready', async (_req, res) => {
        const checks: Record<string, string> = {};
        try {
            await deps.pool.query('SELECT 1');
            checks.db = 'ok';
        } catch {
            checks.db = 'fail';
        }
        // Broker check — 'skipped' when RABBITMQ_URL is unset (events then
        // accumulate in outbox_events until a broker is configured).
        checks.broker = deps.config.RABBITMQ_URL ? (deps.publisher.isConnected() ? 'ok' : 'fail') : 'skipped';
        const ready = Object.values(checks).every((v) => v === 'ok' || v === 'skipped');
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
    });

    // Prometheus scrape — before any auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    // Recruitment surface — the gateway rewrites /api/v1/* → /v1/*.
    // /v1/public is anonymous (rate-limited inside); the rest is HR-only
    // (or service-token) behind the gateway's JWT.
    app.use('/v1/vacancies', vacanciesRouter(deps));
    app.use('/v1/candidates', candidatesRouter(deps));
    app.use('/v1/applications', applicationsRouter(deps));
    app.use('/v1/interviews', interviewsRouter(deps));
    app.use('/v1/offers', offersRouter(deps));
    app.use('/v1/public', publicRouter(deps));
    app.use('/v1/ai', aiRouter(deps));
    // Service-token-only internal API (users_projection upserts — display
    // names for created_by/changed_by joins). Same pattern as hr-core.
    app.use('/v1/internal', internalRouter(deps));

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
