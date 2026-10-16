const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const db = require('../db');
const redisClient = require('../utils/redis');

// Helper: HTTP health check with 5s timeout
async function checkHttp(name, url) {
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        let status = 'healthy';
        if (!res.ok) {
            status = 'degraded';
        } else if (latencyMs > 2000) {
            status = 'degraded';
        }
        return { name, status, latencyMs, url };
    } catch (err) {
        const latencyMs = Date.now() - start;
        return { name, status: 'down', latencyMs, url, error: err.message };
    }
}

// Helper: DB health check
async function checkDb() {
    const name = 'db';
    const url = 'postgres://localhost';
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        await Promise.race([
            db.query('SELECT 1'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        let status = 'healthy';
        if (latencyMs > 2000) {
            status = 'degraded';
        }
        return { name, status, latencyMs, url };
    } catch (err) {
        logger.error({ err: err.message }, 'DB health check failed');
        return { name, status: 'down', latencyMs: Date.now() - start, url, error: err.message };
    }
}

// Helper: Redis health check
async function checkRedis() {
    const name = 'redis';
    const url = 'redis://localhost:6379';
    const start = Date.now();
    try {
        const pingResult = await Promise.race([
            (async () => {
                await redisClient.get('__health_check__');
                return redisClient.ping ? redisClient.ping() : 'PONG';
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        const latencyMs = Date.now() - start;
        let status = 'healthy';
        if (latencyMs > 2000) {
            status = 'degraded';
        }
        return { name, status, latencyMs, url };
    } catch (err) {
        logger.error({ err: err.message }, 'Redis health check failed');
        return { name, status: 'down', latencyMs: Date.now() - start, url, error: err.message };
    }
}

// Helper: RabbitMQ health check via management API (no amqplib dependency)
async function checkRabbitMQ() {
    const name = 'rabbitmq';
    const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
    const url = new URL(rabbitmqUrl);
    const host = url.hostname || 'localhost';
    const port = 15672;
    const user = decodeURIComponent(url.username || 'guest');
    const pass = decodeURIComponent(url.password || 'guest');
    const vhost = encodeURIComponent(url.pathname.slice(1) || '/');
    const healthUrl = `http://${host}:${port}/api/aliveness-test/${vhost}`;
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(healthUrl, {
            signal: controller.signal,
            headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') }
        });
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        let status = 'healthy';
        if (!res.ok) {
            status = 'degraded';
        } else if (latencyMs > 2000) {
            status = 'degraded';
        }
        return { name, status, latencyMs, url: healthUrl };
    } catch (err) {
        return { name, status: 'down', latencyMs: Date.now() - start, url: healthUrl, error: err.message };
    }
}

// GET / — aggregate health status of all services
router.get('/', isAdmin, async (req, res) => {
    const identityUrl = (process.env.IDENTITY_URL || 'http://identity-auth:3001') + '/health';
    const notificationsUrl = (process.env.NOTIFICATIONS_URL || 'http://notifications:3007') + '/health';
    const analyticsUrl = (process.env.ANALYTICS_URL || 'http://analytics:3008') + '/health';
    const aiServiceUrl = (process.env.AI_SERVICE_URL || 'http://ai-matching:3005') + '/health';
    const documentsUrl = (process.env.DOCUMENTS_URL || 'http://documents-resumes:3004') + '/health';
    const minioUrl = (process.env.MINIO_URL || 'http://minio:9000') + '/minio/health/live';
    const gatewayUrl = (process.env.GATEWAY_URL || 'http://gateway:8081') + '/health';
    const mailpitUrl = (process.env.MAILPIT_URL || 'http://mailpit:8025') + '/api/v1/info';

    const checks = [
        checkHttp('api', 'http://localhost:3000/api/health'),
        checkHttp('identity-auth', identityUrl),
        checkHttp('gateway', gatewayUrl),
        checkHttp('notifications', notificationsUrl),
        checkHttp('analytics', analyticsUrl),
        checkHttp('ai-matching', aiServiceUrl),
        checkHttp('documents-resumes', documentsUrl),
        checkDb(),
        checkRedis(),
        checkRabbitMQ(),
        checkHttp('minio', minioUrl),
        checkHttp('mailpit', mailpitUrl),
        // Observability stack
        checkHttp('prometheus', (process.env.PROMETHEUS_URL || 'http://prometheus:9090') + '/-/healthy'),
        checkHttp('grafana', (process.env.GRAFANA_INTERNAL_URL || 'http://grafana:3000') + '/api/health'),
        checkHttp('loki', (process.env.LOKI_URL || 'http://loki:3100') + '/ready'),
        checkHttp('tempo', (process.env.TEMPO_URL || 'http://tempo:3200') + '/ready'),
        checkHttp('alertmanager', (process.env.ALERTMANAGER_URL || 'http://alertmanager:9093') + '/-/healthy')
    ];

    const results = await Promise.allSettled(checks);
    const services = results.map((r) => {
        if (r.status === 'fulfilled') {
            return r.value;
        }
        logger.error({ err: r.reason }, 'Health check promise rejected');
        return { name: 'unknown', status: 'down', latencyMs: 0, url: '', error: r.reason && r.reason.message };
    });

    const summary = {
        total: services.length,
        healthy: services.filter((s) => s.status === 'healthy').length,
        degraded: services.filter((s) => s.status === 'degraded').length,
        down: services.filter((s) => s.status === 'down').length
    };

    res.json({ services, summary });
});

module.exports = router;
