import express, { type Express } from 'express';
import { correlationId, errorHandler, notFound } from '@strafor/node-common';
import type { Pool } from 'pg';
import type { ServiceConfig } from './config.js';
import { metrics } from './metrics.js';
import type { WorkerState } from './worker.js';

export interface AppDeps {
    pool: Pool;
    config: ServiceConfig;
    workerState: () => WorkerState;
}

/**
 * HTTP surface — this is a WORKER: health/readiness/metrics only, no
 * business routes. The sync loop lives in worker.ts + sync.ts.
 */
export function createApp(deps: AppDeps): Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(correlationId);
    app.use(metrics.httpMetricsMiddleware);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'directory-sync' });
    });

    app.get('/ready', async (_req, res) => {
        const checks: Record<string, string> = {};
        try {
            await deps.pool.query('SELECT 1');
            checks.identityDb = 'ok';
        } catch {
            checks.identityDb = 'fail';
        }
        // The loop is "ok" once a cycle finished recently, while one is in
        // flight, or during the first-cycle grace window after boot.
        const state = deps.workerState();
        const graceMs = deps.config.SYNC_INTERVAL_MS * 2;
        const fresh = state.lastFinishedAt != null && Date.now() - state.lastFinishedAt < graceMs;
        checks.syncLoop = state.running || fresh || state.lastFinishedAt == null ? 'ok' : 'stale';
        const ready = Object.values(checks).every((v) => v === 'ok');
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not_ready',
            checks,
            cycles: state.cycles
        });
    });

    // Prometheus scrape — no auth dependency so it is always reachable
    // (optionally gated by METRICS_TOKEN inside the handler).
    app.get('/metrics', metrics.metricsHandler);

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
