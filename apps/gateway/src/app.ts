import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { correlationId, errorHandler, logger, CORRELATION_HEADER, createMetrics } from '@strafor/node-common';
import type { GatewayConfig } from './config.js';
import { resolveUpstream } from './routes.js';
import { v1AuthGuard, stripInboundUserHeaders } from './auth.js';
import { getRedis } from './redis.js';
import { RedisRateLimitStore } from './rateLimit.js';
import { makeProxy } from './proxy.js';
import type { VerifiedClaims } from './auth.js';

const UPLOAD_PATH_RE = /upload|resume|documents/i;

export function createApp(config: GatewayConfig): Express {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);

    const metrics = createMetrics({ serviceName: 'gateway' });

    const redis = getRedis(config.redisUrl);

    app.use(helmet());
    app.use(correlationId);

    // CORS — explicit allowlist; dev default localhost:3000, prod must set env.
    const allowed =
        config.corsOrigins.length > 0
            ? config.corsOrigins
            : config.nodeEnv === 'production'
              ? []
              : ['http://localhost:3000'];
    app.use(
        cors({
            origin: (origin, cb) => {
                if (!origin || allowed.includes(origin)) return cb(null, true);
                return cb(null, false);
            },
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Correlation-Id'],
            credentials: true,
            optionsSuccessStatus: 200
        })
    );

    // HTTP metrics middleware — after CORS, before rate limiting/routes.
    app.use(metrics.httpMetricsMiddleware);

    // Own liveness/readiness — before any proxying.
    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', service: 'gateway', timestamp: new Date() });
    });
    app.get('/ready', async (_req: Request, res: Response) => {
        const checks: Record<string, string> = { redis: 'skipped' };
        let ok = true;
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

    // Prometheus scrape — before any rate limiter/auth so it is always reachable.
    app.get('/metrics', metrics.metricsHandler);

    // Rate limiting — Redis store when configured, memory store otherwise.
    const store = redis ? new RedisRateLimitStore(redis, 'rl:') : undefined;
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 600,
        standardHeaders: true,
        legacyHeaders: false,
        ...(store ? { store } : {}),
        message: { error: 'Too many requests, please try again later.' }
    });
    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 20,
        standardHeaders: true,
        legacyHeaders: false,
        ...(redis ? { store: new RedisRateLimitStore(redis, 'rl:auth:') } : {}),
        message: { error: 'Too many authentication attempts, please try again later.' }
    });
    app.use('/api', apiLimiter);
    app.use('/api/v1/auth/login', loginLimiter);

    // JWT enforcement on /api/v1/** (allowlist inside the guard).
    app.use('/api/v1', v1AuthGuard({ config, redis }));

    // Scrub spoofable identity headers on legacy paths too.
    app.use((req: Request, _res: Response, next: NextFunction) => {
        stripInboundUserHeaders(req);
        next();
    });

    // Single proxy mounted at root; target + rewrite decided per request.
    const decide = (req: Request) => resolveUpstream(req.originalUrl.split('?')[0] ?? req.originalUrl, config);
    const proxyDefault = makeProxy({
        target: config.apiUrl, // unused — router decides; required option
        timeoutMs: config.proxyTimeoutMs,
        dynamic: decide
    });
    const proxyUpload = makeProxy({
        target: config.apiUrl,
        timeoutMs: config.uploadTimeoutMs,
        dynamic: decide
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
        const proxy = UPLOAD_PATH_RE.test(req.originalUrl) ? proxyUpload : proxyDefault;
        return proxy(req, res, next);
    });

    app.use(errorHandler);

    return app;
}

export { logger, CORRELATION_HEADER };
export type { VerifiedClaims };
