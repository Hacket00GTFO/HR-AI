import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { stubIdentityPool, testConfig } from './helpers.js';
import type { WorkerState } from '../src/worker.js';

const idleWorker = (): WorkerState => ({ running: false, lastFinishedAt: null, cycles: 0 });

function app(state: () => WorkerState = idleWorker) {
    return createApp({
        pool: stubIdentityPool([]),
        config: testConfig(),
        workerState: state
    });
}

describe('HTTP surface (worker: health/readiness/metrics only)', () => {
    it('GET /health returns ok without any auth', async () => {
        const res = await request(app()).get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', service: 'directory-sync' });
    });

    it('GET /ready is ready when identity db answers', async () => {
        const res = await request(app()).get('/ready');
        expect(res.status).toBe(200);
        expect(res.body.checks.identityDb).toBe('ok');
    });

    it('GET /ready is 503 when the sync loop went stale', async () => {
        const stale = (): WorkerState => ({
            running: false,
            lastFinishedAt: Date.now() - 10 * 60_000,
            cycles: 5
        });
        const res = await request(app(stale)).get('/ready');
        expect(res.status).toBe(503);
        expect(res.body.checks.syncLoop).toBe('stale');
    });

    it('GET /metrics exposes Prometheus text', async () => {
        const res = await request(app()).get('/metrics');
        expect(res.status).toBe(200);
        expect(res.text).toContain('sync_runs_total');
    });

    it('unknown routes 404 — there are no business routes', async () => {
        const res = await request(app()).get('/v1/anything');
        expect(res.status).toBe(404);
    });
});

describe('loadConfig', () => {
    it('applies defaults', () => {
        const cfg = testConfig();
        expect(cfg.PORT).toBe(3016);
        expect(cfg.SYNC_INTERVAL_MS).toBe(60_000);
        expect(cfg.SYNC_BATCH_SIZE).toBe(500);
        expect(cfg.RECRUITMENT_CORE_URL).toBe('http://recruitment-core:3009');
        expect(cfg.HR_CORE_URL).toBe('http://hr-core:3010');
        expect(cfg.HR_SERVICES_URL).toBe('http://hr-services:3014');
    });

    it('fails fast on missing required env', () => {
        expect(() => loadConfig({})).toThrow(/IDENTITY_DATABASE_URL|SERVICE_AUTH_TOKEN/);
        expect(() => loadConfig({ IDENTITY_DATABASE_URL: 'postgres://x:x@h:5432/db' })).toThrow(/SERVICE_AUTH_TOKEN/);
    });
});
