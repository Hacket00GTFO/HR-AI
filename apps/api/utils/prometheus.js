// Prometheus query client for the admin monitoring API.
// The admin-monitoring route uses a fixed catalog of queries — the client
// never sends raw PromQL. This prevents injection and bounds cardinality.

const logger = require('./logger');

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090';

class PrometheusUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'PrometheusUnavailable';
    }
}

async function fetchPrometheus(path, params = {}, timeoutMs = 5000) {
    const url = new URL(PROMETHEUS_URL + path);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url.toString(), { signal: controller.signal });
        if (!res.ok) {
            throw new PrometheusUnavailable(`Prometheus returned ${res.status}`);
        }
        const body = await res.json();
        if (body.status !== 'success') {
            throw new PrometheusUnavailable(body.error || 'Prometheus query failed');
        }
        return body;
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new PrometheusUnavailable('Prometheus request timed out');
        }
        if (err.name === 'TypeError' || err.code === 'ECONNREFUSED') {
            throw new PrometheusUnavailable('Prometheus is not reachable');
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Instant query — returns the latest value of an expression
async function instantQuery(expr, timeoutMs = 5000) {
    const body = await fetchPrometheus('/api/v1/query', { query: expr }, timeoutMs);
    return body.data.result;
}

// Range query — returns a time series for an expression
async function rangeQuery(expr, { start, end, step }, timeoutMs = 10000) {
    const body = await fetchPrometheus(
        '/api/v1/query_range',
        {
            query: expr,
            start: Math.floor(start.getTime() / 1000),
            end: Math.floor(end.getTime() / 1000),
            step
        },
        timeoutMs
    );
    return body.data.result;
}

// Label values — returns all values for a label, optionally scoped to a
// series selector (e.g. labelValues('service', 'http_requests_total'))
async function labelValues(label, match = null, timeoutMs = 5000) {
    const params = match ? { 'match[]': match } : {};
    const body = await fetchPrometheus(`/api/v1/label/${label}/values`, params, timeoutMs);
    return body.data;
}

// Derive the scrape step from the requested range to keep point count <= 300
function deriveStep(rangeMinutes) {
    if (rangeMinutes <= 15) return '15s';
    if (rangeMinutes <= 60) return '30s';
    if (rangeMinutes <= 360) return '1m';
    if (rangeMinutes <= 1440) return '5m';
    if (rangeMinutes <= 10080) return '30m';
    return '1h';
}

// Query catalog — all PromQL used by the admin-monitoring route.
// Functions take validated params and return PromQL strings.
const QUERIES = {
    // Overview KPIs
    containersTotal: () => 'count(strafor:container_memory_working_set_bytes{container!=""})',
    containersUp: () => 'count(strafor:probe_success{job="blackbox-http"} == 1)',
    containersDown: () => 'count(strafor:probe_success{job="blackbox-http"} == 0)',
    cpuTotalPercent: () => 'sum(strafor:container_cpu_percent:rate2m)',
    memoryTotalBytes: () => 'sum(strafor:container_memory_working_set_bytes)',
    rpsGlobal: () => 'sum(rate(http_requests_total[5m]))',
    errorRatioGlobal: () =>
        'sum(rate(http_requests_total{status_class="5xx"}[5m])) / sum(rate(http_requests_total[5m]))',
    alertsFiring: () => 'count(ALERTS{alertstate="firing"})',

    // Per-container
    containerList: () => 'strafor:container_memory_working_set_bytes',
    containerCpu: (container) => `strafor:container_cpu_percent:rate2m{container="${container}"}`,
    containerMemory: (container) => `strafor:container_memory_working_set_bytes{container="${container}"}`,
    containerMemoryLimit: (container) => `strafor:container_memory_limit_bytes{container="${container}"}`,
    containerNetRx: (container) => `strafor:container_network_rx_bytes:rate2m{container="${container}"}`,
    containerNetTx: (container) => `strafor:container_network_tx_bytes:rate2m{container="${container}"}`,
    containerFsRead: (container) => `strafor:container_fs_read_bytes:rate2m{container="${container}"}`,
    containerFsWrite: (container) => `strafor:container_fs_write_bytes:rate2m{container="${container}"}`,
    containerRestarts: (container) => `strafor:container_restarts:changes1h{container="${container}"}`,
    containerSparklineCpu: () => 'strafor:container_cpu_percent:rate2m',
    containerSparklineMemory: () => 'strafor:container_memory_working_set_bytes',

    // Per-service RED
    servicesRed: () => 'strafor:http_requests:rate5m',
    serviceRps: (service) => `sum(rate(http_requests_total{service="${service}"}[5m]))`,
    serviceErrorRatio: (service) =>
        `sum(rate(http_requests_total{service="${service}",status_class="5xx"}[5m])) / sum(rate(http_requests_total{service="${service}"}[5m]))`,
    serviceP50: (service) =>
        `histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{service="${service}"}[5m])))`,
    serviceP95: (service) =>
        `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="${service}"}[5m])))`,
    serviceP99: (service) =>
        `histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service="${service}"}[5m])))`,

    // Prometheus targets
    targets: () => null // uses /api/v1/targets directly
};

module.exports = {
    instantQuery,
    rangeQuery,
    labelValues,
    deriveStep,
    fetchPrometheus,
    PrometheusUnavailable,
    QUERIES
};
