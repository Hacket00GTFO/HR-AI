// Prometheus metrics for Node.js services.
// - httpMetricsMiddleware: counts/durations HTTP requests with normalized routes
// - metricsHandler: exposes /metrics (optionally protected by METRICS_TOKEN)
// - collectDefaultMetrics: process/event-loop/GC metrics
// - helpers: counter, gauge, histogram for domain metrics
//
// Usage:
//   const { createMetrics } = require('@strafor/node-common/metrics');
//   const metrics = createMetrics({ serviceName: 'api' });
//   app.use(metrics.httpMetricsMiddleware);
//   app.get('/metrics', metrics.metricsHandler);

const promClient = require('prom-client');
const crypto = require('crypto');

const EXCLUDED_PATHS = new Set(['/metrics', '/health', '/ready', '/favicon.ico']);

// Normalize Express route paths to keep label cardinality bounded.
// /api/candidates/123  -> /api/candidates/:id
// /api/vacancies/uuid-1 -> /api/vacancies/:id
function normalizeRoute(req) {
    // Prefer the matched route pattern (Express 4+)
    if (req.route && req.route.path) {
        const base = req.baseUrl || '';
        return base + req.route.path;
    }
    // Fallback: collapse numeric/UUID segments in the raw path
    const path = req.path || req.url || '/';
    return path
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
        .replace(/\/\d+(?=\/|$)/g, '/:id');
}

function statusClass(code) {
    if (code < 200) return '1xx';
    if (code < 300) return '2xx';
    if (code < 400) return '3xx';
    if (code < 500) return '4xx';
    return '5xx';
}

/**
 * Create a metrics bundle for a service.
 * @param {{ serviceName: string, registry?: promClient.Registry, collectDefaults?: boolean }} opts
 */
function createMetrics(opts = {}) {
    const serviceName = opts.serviceName || process.env.SERVICE_NAME || 'strafor-service';
    const registry = opts.registry || new promClient.Registry();
    const collectDefaults = opts.collectDefaults !== false;

    if (collectDefaults) {
        promClient.collectDefaultMetrics({
            register: registry,
            labels: { service: serviceName }
        });
    }

    // HTTP metrics
    const httpRequestsTotal = new promClient.Counter({
        name: 'http_requests_total',
        help: 'Total HTTP requests',
        labelNames: ['service', 'method', 'route', 'status_class'],
        registers: [registry]
    });

    const httpRequestDurationSeconds = new promClient.Histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP request duration in seconds',
        labelNames: ['service', 'method', 'route'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [registry]
    });

    const httpRequestsInFlight = new promClient.Gauge({
        name: 'http_requests_in_flight',
        help: 'HTTP requests currently in flight',
        labelNames: ['service'],
        registers: [registry]
    });

    // Exemplar support — attach trace_id to histogram observations when available
    const exemplarFn = () => {
        try {
            const api = require('@opentelemetry/api');
            const span = api.trace.getActiveSpan();
            if (span) {
                const ctx = span.spanContext();
                return { traceID: ctx.traceId };
            }
        } catch {
            // @opentelemetry/api not loaded — no exemplars
        }
        return undefined;
    };
    // Enable exemplars on the registry (prom-client >= 15)
    if (typeof registry.setExemplarFn === 'function') {
        registry.setExemplarFn(exemplarFn);
    }

    // Express middleware
    function httpMetricsMiddleware(req, res, next) {
        // Skip excluded paths
        const path = req.path || (req.url || '').split('?')[0];
        if (EXCLUDED_PATHS.has(path)) return next();

        httpRequestsInFlight.inc({ service: serviceName });

        const start = process.hrtime.bigint();

        res.on('finish', () => {
            httpRequestsInFlight.dec({ service: serviceName });

            const durationNs = Number(process.hrtime.bigint() - start);
            const durationSec = durationNs / 1e9;

            const route = normalizeRoute(req);
            const method = req.method || 'UNKNOWN';
            const sc = statusClass(res.statusCode);

            httpRequestsTotal.inc({ service: serviceName, method, route, status_class: sc });
            httpRequestDurationSeconds.observe({ service: serviceName, method, route }, durationSec);
        });

        next();
    }

    // /metrics handler — optionally protected by METRICS_TOKEN
    function metricsHandler(req, res) {
        const token = process.env.METRICS_TOKEN;
        if (token) {
            const auth = req.headers.authorization || '';
            const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
            if (!provided || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
        }
        res.setHeader('Content-Type', registry.contentType);
        registry.metrics().then((body) => res.end(body));
    }

    // Helpers for domain-specific metrics
    function counter(name, help, labelNames = []) {
        const c = new promClient.Counter({
            name,
            help,
            labelNames: ['service', ...labelNames],
            registers: [registry]
        });
        return {
            inc(labels = {}, value = 1) {
                c.inc({ service: serviceName, ...labels }, value);
            }
        };
    }

    function gauge(name, help, labelNames = []) {
        const g = new promClient.Gauge({
            name,
            help,
            labelNames: ['service', ...labelNames],
            registers: [registry]
        });
        return {
            set(labels, value) {
                g.set({ service: serviceName, ...labels }, value);
            },
            inc(labels = {}, value = 1) {
                g.inc({ service: serviceName, ...labels }, value);
            },
            dec(labels = {}, value = 1) {
                g.dec({ service: serviceName, ...labels }, value);
            }
        };
    }

    function histogram(name, help, labelNames = [], buckets) {
        const h = new promClient.Histogram({
            name,
            help,
            labelNames: ['service', ...labelNames],
            buckets: buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            registers: [registry]
        });
        return {
            observe(labels, value) {
                h.observe({ service: serviceName, ...labels }, value);
            }
        };
    }

    return {
        registry,
        httpMetricsMiddleware,
        metricsHandler,
        counter,
        gauge,
        histogram
    };
}

module.exports = { createMetrics, normalizeRoute, statusClass };
