// Admin monitoring route — proxies curated Prometheus queries to the admin UI.
// The client never sends raw PromQL; all queries are in the QUERIES catalog.
const express = require('express');
const { isAdmin } = require('../middleware/auth');
const {
    instantQuery,
    rangeQuery,
    labelValues,
    deriveStep,
    fetchPrometheus,
    PrometheusUnavailable,
    QUERIES
} = require('../utils/prometheus');

const router = express.Router();

// All routes require admin
router.use(isAdmin);

// Valid ranges (minutes) and their step derivation
const VALID_RANGES = {
    '15m': 15,
    '1h': 60,
    '6h': 360,
    '24h': 1440,
    '7d': 10080,
    '30d': 43200,
    '90d': 129600
};

// Container name validation (Docker container name format)
const CONTAINER_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
// Service name validation
const SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseRange(rangeStr) {
    const minutes = VALID_RANGES[rangeStr];
    if (!minutes) return null;
    return minutes;
}

// GET /api/admin/monitoring/overview — KPI cards
router.get('/overview', async (req, res) => {
    try {
        const [containersTotal, containersUp, containersDown, cpuTotal, memTotal, rps, errorRatio, alertsFiring] =
            await Promise.all([
                instantQuery(QUERIES.containersTotal()),
                instantQuery(QUERIES.containersUp()),
                instantQuery(QUERIES.containersDown()),
                instantQuery(QUERIES.cpuTotalPercent()),
                instantQuery(QUERIES.memoryTotalBytes()),
                instantQuery(QUERIES.rpsGlobal()),
                instantQuery(QUERIES.errorRatioGlobal()),
                instantQuery(QUERIES.alertsFiring())
            ]);

        const val = (result) => (result && result[0] ? parseFloat(result[0].value[1]) : 0);

        res.json({
            containers: {
                total: val(containersTotal),
                up: val(containersUp),
                down: val(containersDown)
            },
            cpuTotalPercent: val(cpuTotal),
            memoryTotalBytes: val(memTotal),
            rps: val(rps),
            errorRatio: val(errorRatio),
            alertsFiring: val(alertsFiring)
        });
    } catch (err) {
        if (err instanceof PrometheusUnavailable) {
            return res.status(503).json({ error: 'prometheus_unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /api/admin/monitoring/containers — container list with current values
router.get('/containers', async (req, res) => {
    try {
        const result = await instantQuery(QUERIES.containerList());
        const containers = result.map((item) => ({
            container: item.metric.container || '',
            service: item.metric.service || '',
            memoryBytes: parseFloat(item.value[1])
        }));

        // Fetch CPU, restarts, and probe success for each container in parallel
        const enriched = await Promise.all(
            containers.map(async (c) => {
                try {
                    const [cpu, restarts, probe] = await Promise.all([
                        instantQuery(QUERIES.containerCpu(c.container)),
                        instantQuery(QUERIES.containerRestarts(c.container)),
                        instantQuery(`probe_success{service="${c.service}"}`)
                    ]);
                    return {
                        ...c,
                        cpuPercent: cpu && cpu[0] ? parseFloat(cpu[0].value[1]) : 0,
                        restarts1h: restarts && restarts[0] ? parseFloat(restarts[0].value[1]) : 0,
                        probeSuccess: probe && probe[0] ? parseFloat(probe[0].value[1]) : null
                    };
                } catch {
                    return { ...c, cpuPercent: 0, restarts1h: 0, probeSuccess: null };
                }
            })
        );

        res.json({ containers: enriched });
    } catch (err) {
        if (err instanceof PrometheusUnavailable) {
            return res.status(503).json({ error: 'prometheus_unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /api/admin/monitoring/containers/:name/series?range=1h
router.get('/containers/:name/series', async (req, res) => {
    const container = req.params.name;
    if (!CONTAINER_RE.test(container)) {
        return res.status(400).json({ error: 'Invalid container name' });
    }

    const rangeMinutes = parseRange(req.query.range || '1h');
    if (!rangeMinutes) {
        return res.status(400).json({ error: 'Invalid range. Use: 15m, 1h, 6h, 24h, 7d, 30d, 90d' });
    }

    const step = deriveStep(rangeMinutes);
    const end = new Date();
    const start = new Date(end.getTime() - rangeMinutes * 60 * 1000);

    try {
        const series = {};
        const metrics = [
            { key: 'cpu', query: QUERIES.containerCpu(container) },
            { key: 'memory', query: QUERIES.containerMemory(container) },
            { key: 'memoryLimit', query: QUERIES.containerMemoryLimit(container) },
            { key: 'netRx', query: QUERIES.containerNetRx(container) },
            { key: 'netTx', query: QUERIES.containerNetTx(container) },
            { key: 'fsRead', query: QUERIES.containerFsRead(container) },
            { key: 'fsWrite', query: QUERIES.containerFsWrite(container) }
        ];

        const results = await Promise.all(
            metrics.map((m) => rangeQuery(m.query, { start, end, step }).catch(() => []))
        );

        for (let i = 0; i < metrics.length; i++) {
            const r = results[i];
            series[metrics[i].key] =
                r && r[0] ? r[0].values.map(([ts, v]) => ({ ts: ts * 1000, value: parseFloat(v) })) : [];
        }

        res.json({ container, range: req.query.range, series });
    } catch (err) {
        if (err instanceof PrometheusUnavailable) {
            return res.status(503).json({ error: 'prometheus_unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /api/admin/monitoring/containers/sparklines?range=1h
// Returns CPU + memory sparkline data for all containers (for Service Health)
router.get('/containers/sparklines', async (req, res) => {
    const rangeMinutes = parseRange(req.query.range || '1h');
    if (!rangeMinutes) {
        return res.status(400).json({ error: 'Invalid range' });
    }

    const step = deriveStep(rangeMinutes);
    const end = new Date();
    const start = new Date(end.getTime() - rangeMinutes * 60 * 1000);

    try {
        const [cpuResult, memResult] = await Promise.all([
            rangeQuery(QUERIES.containerSparklineCpu(), { start, end, step }).catch(() => []),
            rangeQuery(QUERIES.containerSparklineMemory(), { start, end, step }).catch(() => [])
        ]);

        const sparklines = {};
        for (const r of cpuResult) {
            const container = r.metric.container || '';
            if (!sparklines[container]) sparklines[container] = {};
            sparklines[container].cpu = r.values.map(([ts, v]) => ({ ts: ts * 1000, value: parseFloat(v) }));
        }
        for (const r of memResult) {
            const container = r.metric.container || '';
            if (!sparklines[container]) sparklines[container] = {};
            sparklines[container].memory = r.values.map(([ts, v]) => ({ ts: ts * 1000, value: parseFloat(v) }));
        }

        res.json({ sparklines, range: req.query.range || '1h' });
    } catch (err) {
        if (err instanceof PrometheusUnavailable) {
            return res.status(503).json({ error: 'prometheus_unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /api/admin/monitoring/services/red?range=1h
router.get('/services/red', async (req, res) => {
    try {
        // Only services that actually emit HTTP request metrics — exporters
        // and infra jobs share the 'service' label but would show as all-zero rows
        const services = await labelValues('service', 'http_requests_total');
        const enriched = await Promise.all(
            services.map(async (service) => {
                if (!SERVICE_RE.test(service)) return null;
                try {
                    const [rps, errorRatio, p50, p95, p99] = await Promise.all([
                        instantQuery(QUERIES.serviceRps(service)),
                        instantQuery(QUERIES.serviceErrorRatio(service)),
                        instantQuery(QUERIES.serviceP50(service)),
                        instantQuery(QUERIES.serviceP95(service)),
                        instantQuery(QUERIES.serviceP99(service))
                    ]);
                    const val = (r) => (r && r[0] ? parseFloat(r[0].value[1]) : 0);
                    return {
                        service,
                        rps: val(rps),
                        errorRatio: val(errorRatio),
                        p50: val(p50),
                        p95: val(p95),
                        p99: val(p99)
                    };
                } catch {
                    return { service, rps: 0, errorRatio: 0, p50: 0, p95: 0, p99: 0 };
                }
            })
        );

        res.json({ services: enriched.filter(Boolean) });
    } catch (err) {
        if (err instanceof PrometheusUnavailable) {
            return res.status(503).json({ error: 'prometheus_unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /api/admin/monitoring/targets — Prometheus scrape targets health
router.get('/targets', async (req, res) => {
    try {
        const body = await fetchPrometheus('/api/v1/targets');
        const targets = (body.data.activeTargets || []).map((t) => ({
            job: t.labels.job || '',
            instance: t.labels.instance || '',
            health: t.health,
            lastError: t.lastError || '',
            lastScrape: t.lastScrape || ''
        }));
        res.json({ targets });
    } catch (err) {
        if (err instanceof PrometheusUnavailable) {
            return res.status(503).json({ error: 'prometheus_unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /api/admin/monitoring/whoami — used by the web BFF to verify admin role
router.get('/whoami', (req, res) => {
    res.json({ email: req.user.email, role: req.user.role });
});

// GET /api/admin/monitoring/links — Grafana dashboard UIDs/panel IDs for embeds
router.get('/links', (req, res) => {
    res.json({
        grafanaPath: process.env.GRAFANA_PUBLIC_PATH || '/api/grafana',
        dashboards: {
            containersOverview: { uid: 'strafor-containers-overview', panels: { cpu: 1, memory: 2, network: 3 } },
            containerDetail: { uid: 'strafor-container-detail' },
            servicesRed: { uid: 'strafor-services-red' },
            datastores: { uid: 'strafor-platform-datastores' },
            aiMatching: { uid: 'strafor-ai-matching' },
            logs: { uid: 'strafor-logs-explorer' },
            traces: { uid: 'strafor-traces' },
            alerts: { uid: 'strafor-alerts-overview' }
        }
    });
});

module.exports = router;
