import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { correlationId, errorHandler, notFound, logger, createMetrics } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';
import { initPool, getPool } from './db.js';
import { getRedis } from './redis.js';
import { loadKeys, type KeySet } from './keys.js';
import { authRouter, type RouteDeps } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { settingsRouter } from './routes/settings.js';
import { auditRouter } from './routes/audit.js';
import { mfaRouter } from './routes/mfa.js';
import { oidcRouter } from './routes/oidc.js';

export interface CreatedApp {
    app: Express;
    keys: KeySet;
    config: ServiceConfig;
    metrics: ReturnType<typeof createMetrics>;
}

export async function createApp(config: ServiceConfig): Promise<CreatedApp> {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);

    const metrics = createMetrics({ serviceName: 'identity-auth' });

    initPool(config);
    const redis = getRedis(config.redisUrl);
    const keys = await loadKeys(config);
    const deps: RouteDeps = { config, keys, redis };

    app.use(helmet());
    app.use(correlationId);
    app.use(express.json({ limit: '1mb' }));

    // HTTP metrics middleware — after CORS/correlationId, before routes.
    app.use(metrics.httpMetricsMiddleware);

    // ---- infra endpoints (no auth) ----
    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', service: 'identity-auth', timestamp: new Date() });
    });

    app.get('/ready', async (_req: Request, res: Response) => {
        const checks: Record<string, string> = { db: 'down', redis: 'skipped' };
        let ok = true;
        try {
            await getPool().query('SELECT 1');
            checks['db'] = 'up';
        } catch {
            ok = false;
        }
        if (redis) {
            try {
                await redis.ping();
                checks['redis'] = 'up';
            } catch {
                checks['redis'] = 'down';
                ok = false;
            }
        }
        res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
    });

    // Public JWKS — gateway + services verify RS256 tokens against this.
    app.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
        res.json({ keys: [keys.publicJwk] });
    });

    // Prometheus scrape — before any rate limiter/auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    // ---- rate limits ----
    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many authentication attempts, please try again later.' }
    });
    app.use('/v1/auth/login', authLimiter);
    app.use('/v1/auth/password/forgot', authLimiter);
    // MFA challenge exchange is a credential endpoint — same strict limit.
    app.use('/v1/auth/mfa/verify', authLimiter);

    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 600,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, please try again later.' }
    });
    app.use('/v1', apiLimiter);

    // ---- routes ----
    app.use('/v1/auth', authRouter(deps));
    app.use('/v1/users', usersRouter(deps));
    app.use('/v1/settings', settingsRouter(deps));
    app.use('/v1/audit', auditRouter(deps));
    app.use('/v1/auth/mfa', mfaRouter(deps));
    app.use('/v1/auth/oidc', oidcRouter(deps));

    app.use(notFound);
    app.use(errorHandler);

    return { app, keys, config, metrics };
}

export { logger };
