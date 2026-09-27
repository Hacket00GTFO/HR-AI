// PostgreSQL pool metrics observer.
// Polls pg.Pool stats every 5s and updates Prometheus gauges.
//
// Usage:
//   const { observePool } = require('@strafor/node-common/pgMetrics');
//   observePool(db.pool, { serviceName: 'api', metrics });

const DEFAULT_INTERVAL_MS = 5000;

/**
 * Observe a pg.Pool and expose pool metrics via the provided metrics bundle.
 * @param {import('pg').Pool} pool
 * @param {{ serviceName?: string, metrics?: object, intervalMs?: number }} opts
 * @returns {() => void} stop function
 */
function observePool(pool, opts = {}) {
    const metrics = opts.metrics;
    const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;

    if (!metrics) return () => {};

    const totalGauge = metrics.gauge('pg_pool_total', 'Total connections in pool');
    const idleGauge = metrics.gauge('pg_pool_idle', 'Idle connections in pool');
    const waitingGauge = metrics.gauge('pg_pool_waiting', 'Connections waiting for pool');
    const activeGauge = metrics.gauge('pg_pool_active', 'Active connections in pool');

    const timer = setInterval(() => {
        try {
            totalGauge.set({}, pool.totalCount);
            idleGauge.set({}, pool.idleCount);
            waitingGauge.set({}, pool.waitingCount);
            activeGauge.set({}, pool.totalCount - pool.idleCount);
        } catch {
            // Pool not ready yet — skip
        }
    }, intervalMs);

    return () => clearInterval(timer);
}

module.exports = { observePool };
