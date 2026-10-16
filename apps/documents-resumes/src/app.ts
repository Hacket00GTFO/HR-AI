import express, { type Express } from 'express';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { correlationId, errorHandler, notFound, createMetrics } from '@strafor/node-common';
import { documentsRouter, type DocumentsDeps } from './routes/documents.js';

// Metrics bundle — created at module level so route handlers can import
// the domain counter without depending on the Express app.
const metrics = createMetrics({ serviceName: 'documents-resumes' });

// Domain metric: documents uploaded by type.
export const documentsUploaded = metrics.counter('documents_uploaded_total', 'Total documents uploaded', ['type']);

export { metrics };

export function createApp(deps: DocumentsDeps): Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(correlationId);

    // HTTP metrics middleware — after correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'documents-resumes' });
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
            await deps.s3.send(new HeadBucketCommand({ Bucket: deps.bucket }));
            checks.s3 = 'ok';
        } catch {
            checks.s3 = 'fail';
        }
        const ready = Object.values(checks).every((v) => v === 'ok');
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
    });

    // Prometheus scrape — before any rate limiter/auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    app.use('/v1/documents', documentsRouter(deps));
    app.use(notFound);
    app.use(errorHandler);
    return app;
}
