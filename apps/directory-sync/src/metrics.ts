import { createMetrics, type MetricsCounter, type MetricsHistogram } from '@strafor/node-common';

// Metrics bundle — module level so the sync worker and the Express app share
// one registry (same pattern as the other services).
const metrics = createMetrics({ serviceName: 'directory-sync' });

/** Per-step run outcomes: sync_runs_total{step,status=ok|error|skipped}. */
export const syncRuns: MetricsCounter = metrics.counter('sync_runs_total', 'Total directory-sync step executions', [
    'step',
    'status'
]);

/** Rows read from a source or written/deleted at a target: sync_rows_total{step}. */
export const syncRows: MetricsCounter = metrics.counter('sync_rows_total', 'Rows processed per directory-sync step', [
    'step'
]);

/** Per-step wall time: sync_duration_seconds{step}. */
export const syncDuration: MetricsHistogram = metrics.histogram(
    'sync_duration_seconds',
    'Directory-sync step duration in seconds',
    ['step']
);

export interface SyncMetrics {
    runs: MetricsCounter;
    rows: MetricsCounter;
    duration: MetricsHistogram;
}

export const syncMetrics: SyncMetrics = { runs: syncRuns, rows: syncRows, duration: syncDuration };

export { metrics };
