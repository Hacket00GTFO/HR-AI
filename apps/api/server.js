// OpenTelemetry tracing MUST be initialized before any other require
// so auto-instrumentation can patch http/express/pg/ioredis/amqplib.
require('@strafor/node-common/tracing').startTracing({ serviceName: 'api' });

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const { router: authRoutes } = require('./routes/auth');
const hrAccountRoutes = require('./routes/hr-accounts');
const adminAccountsRoutes = require('./routes/admin-accounts');
const countriesRoutes = require('./routes/countries');
const settingsRoutes = require('./routes/settings');
const userRoutes = require('./routes/user');
const vacanciesRoutes = require('./routes/vacancies');
const candidatesRoutes = require('./routes/candidates');
const dashboardRoutes = require('./routes/dashboard');
const publicRoutes = require('./routes/public');
const aiRoutes = require('./routes/ai');
const hrRoutes = require('./routes/hr');
const adminHealthRoutes = require('./routes/admin-health');
const adminJobsRoutes = require('./routes/admin-jobs');
const adminAuditRoutes = require('./routes/admin-audit');
const adminAnalyticsRoutes = require('./routes/admin-analytics');
const adminNotificationsRoutes = require('./routes/admin-notifications');
const adminEmailTemplatesRoutes = require('./routes/admin-email-templates');
const adminApiKeysRoutes = require('./routes/admin-api-keys');
const adminWebhooksRoutes = require('./routes/admin-webhooks');
const adminApprovalsRoutes = require('./routes/admin-approvals');
const adminFeatureFlagsRoutes = require('./routes/admin-feature-flags');
const adminIpAllowlistRoutes = require('./routes/admin-ip-allowlist');
const adminDataRetentionRoutes = require('./routes/admin-data-retention');
const adminBrandingRoutes = require('./routes/admin-branding');
const adminBulkRoutes = require('./routes/admin-bulk');
const adminMonitoringRoutes = require('./routes/admin-monitoring');
const adminAlertsRoutes = require('./routes/admin-alerts');
const { createMetrics, observePool } = require('@strafor/node-common');
const { createRelay } = require('./utils/outboxRelay');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

let dbConnected = false;

// Prometheus metrics — initialized before any middleware so /metrics and
// the HTTP middleware are available even during startup (before DB connects).
const metrics = createMetrics({ serviceName: 'api' });

// Fail fast on missing required secrets — never fall back to defaults.
// JWT_SECRET is only needed when legacy HS256 tokens are still accepted
// (ALLOW_LEGACY_HS256=true). RS256 tokens are verified against the
// identity-auth JWKS endpoint (IDENTITY_JWKS_URL) and need no local secret.
const allowLegacyHs256 = (process.env.ALLOW_LEGACY_HS256 || '').toLowerCase() === 'true';
if (allowLegacyHs256 && !process.env.JWT_SECRET) {
    logger.error('FATAL: ALLOW_LEGACY_HS256=true requires JWT_SECRET. See .env.example.');
    process.exit(1);
}
if (!allowLegacyHs256 && !process.env.JWT_SECRET) {
    logger.warn('JWT_SECRET unset — legacy HS256 disabled; verifying RS256 via IDENTITY_JWKS_URL only.');
}

// Security headers. The monolith is API-only now (the Next.js app in apps/web
// is the sole frontend), so Helmet's default CSP is safe to enable.
app.use(
    helmet({
        crossOriginEmbedderPolicy: false
    })
);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// CORS — explicit allowlist. Never origin:true combined with credentials.
// CORS_ORIGIN: comma-separated list of allowed origins. In development it
// defaults to the Next.js app on :3010 and the monolith on :3000; in
// production it must be set explicitly.
const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
          .map((o) => o.trim())
          .filter(Boolean)
    : isProduction
      ? []
      : ['http://localhost:3000', 'http://localhost:3010'];

app.use(
    cors({
        origin: (origin, callback) => {
            // No Origin header → same-origin browser request or server-to-server call.
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            return callback(null, false);
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
        credentials: true, // only ever returned alongside an allowlisted origin
        optionsSuccessStatus: 200
    })
);

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later.' }
});

// Health check — registered BEFORE the DB guard and rate limiter so
// orchestrators/monitors can always probe it. Reports real DB status.
app.get('/api/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        if (!dbConnected) {
            // Connected but migrations still pending/failed — not ready.
            return res.status(503).json({ status: 'degraded', db: 'down', timestamp: new Date() });
        }
        res.json({ status: 'ok', db: 'up', timestamp: new Date() });
    } catch (err) {
        res.status(503).json({ status: 'degraded', db: 'down', timestamp: new Date() });
    }
});

// Prometheus /metrics endpoint — BEFORE the rate limiter and DB guard so
// Prometheus can always scrape it. Protected by METRICS_TOKEN (Bearer).
app.get('/metrics', metrics.metricsHandler);

// HTTP metrics middleware — after CORS, before rate limiter and routes.
app.use(metrics.httpMetricsMiddleware);

app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Secure upload directory (NOT publicly served — access goes through
// GET /api/candidates/:id/resume which requires auth).
// Lives at the repo root (../../ from apps/api), outside the package on
// purpose — runtime data, not source. Override with RESUMES_DIR (Docker).
const resumesDir = process.env.RESUMES_DIR || path.join(__dirname, '..', '..', 'secure_uploads', 'resumes');
if (!fs.existsSync(resumesDir)) {
    fs.mkdirSync(resumesDir, { recursive: true });
}

// Database connection guard middleware — replaces per-handler checkDbConnection() calls
app.use('/api', (req, res, next) => {
    if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected. Please try again later.' });
    }
    next();
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/hr-accounts', hrAccountRoutes);
app.use('/api/admin-accounts', adminAccountsRoutes);
app.use('/api/countries', countriesRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/vacancies', vacanciesRoutes);
app.use('/api/candidates', candidatesRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api/admin/health', adminHealthRoutes);
app.use('/api/admin/jobs', adminJobsRoutes);
app.use('/api/admin/audit', adminAuditRoutes);
app.use('/api/admin/analytics', adminAnalyticsRoutes);
app.use('/api/admin/notifications', adminNotificationsRoutes);
app.use('/api/admin/email-templates', adminEmailTemplatesRoutes);
app.use('/api/admin/api-keys', adminApiKeysRoutes);
app.use('/api/admin/webhooks', adminWebhooksRoutes);
app.use('/api/admin/approvals', adminApprovalsRoutes);
app.use('/api/admin/feature-flags', adminFeatureFlagsRoutes);
app.use('/api/admin/ip-allowlist', adminIpAllowlistRoutes);
app.use('/api/admin/data-retention', adminDataRetentionRoutes);
app.use('/api/admin/branding', adminBrandingRoutes);
app.use('/api/admin/bulk', adminBulkRoutes);
app.use('/api/hr/bulk', adminBulkRoutes); // same router; per-endpoint role checks apply
app.use('/api/admin/monitoring', adminMonitoringRoutes);
app.use('/api/admin/alerts', adminAlertsRoutes);

// The monolith is API-only — the Next.js app in apps/web is the sole frontend.
// Unknown /api/* routes get a JSON 404; any other path gets a JSON 404 too.
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Error handler — generic messages in production, no stack traces, no echoes
// of submitted data.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error('Express error:', err);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const message = status === 500 ? (isProduction ? 'Server error' : err.message || 'Server error') : err.message;
    res.status(status).json({ error: message });
});

// Listen immediately so /api/health can report db:'down' while Postgres is
// unreachable, then connect + migrate in the background and flip the DB guard.
async function start() {
    let relay = null;
    const server = app.listen(PORT, () => {
        logger.info(`Server is running on port ${PORT}`);
    });

    try {
        await db.waitForConnection(); // retries forever — never process.exit()
        await db.runMigrations(); // node-pg-migrate up (migrations/)
        dbConnected = true;
        // Observe the pg.Pool for Prometheus metrics (pool size, idle, waiting).
        if (db.pool) observePool(db.pool, { metrics });
        // Transactional outbox relay — drains outbox_events to RabbitMQ.
        // Starts only after migrations so the table is guaranteed to exist;
        // degrades gracefully (pending rows accumulate) when the broker is down.
        relay = createRelay();
        relay.start();
        logger.info('Database connected and migrated — API is live');
    } catch (err) {
        // DB is reachable but migrations failed. Keep serving /api/health
        // (db:'down') and 503s instead of running against a stale schema.
        logger.error('Database migration failed:', err);
    }

    const shutdown = (signal) => {
        logger.info(`${signal} received — shutting down gracefully`);
        server.close(async () => {
            if (relay) await relay.stop(); // stop polling + close amqp conn
            await db.shutdown();
            process.exit(0);
        });
        // Hard-exit if connections don't drain in time.
        setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// Export the app for tests; only listen when run directly.
module.exports = {
    app,
    // Test hook: lets tests bypass the DB-not-connected guard.
    setDbConnected: (value) => {
        dbConnected = value;
    }
};

if (require.main === module) {
    start();
}
