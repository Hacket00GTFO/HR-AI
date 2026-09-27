import { NextResponse } from 'next/server';

// Basic /metrics endpoint for Prometheus scraping.
// Returns process-level metrics in Prometheus exposition format.
export async function GET() {
    const mem = process.memoryUsage();
    const metrics =
        [
            '# HELP process_resident_memory_bytes Resident memory size in bytes.',
            '# TYPE process_resident_memory_bytes gauge',
            `process_resident_memory_bytes ${mem.rss}`,
            '# HELP process_heap_used_bytes Process heap used in bytes.',
            '# TYPE process_heap_used_bytes gauge',
            `process_heap_used_bytes ${mem.heapUsed}`,
            '# HELP process_heap_total_bytes Process heap total in bytes.',
            '# TYPE process_heap_total_bytes gauge',
            `process_heap_total_bytes ${mem.heapTotal}`,
            '# HELP process_uptime_seconds Process uptime in seconds.',
            '# TYPE process_uptime_seconds gauge',
            `process_uptime_seconds ${process.uptime()}`,
            '# HELP nodejs_eventloop_lag_seconds Event loop lag in seconds.',
            '# TYPE nodejs_eventloop_lag_seconds gauge',
            'nodejs_eventloop_lag_seconds 0'
        ].join('\n') + '\n';

    return new NextResponse(metrics, {
        headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }
    });
}
