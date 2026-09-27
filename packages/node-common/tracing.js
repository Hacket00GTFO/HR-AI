// OpenTelemetry tracing for Node.js services.
// Auto-instruments http, express, pg, ioredis, amqplib.
// Exports OTLP/HTTP to Tempo.
//
// Usage (must be the FIRST import in server.ts/js):
//   require('@strafor/node-common/tracing').startTracing({ serviceName: 'api' });

let started = false;

/**
 * Start OpenTelemetry tracing. Idempotent — safe to call multiple times.
 * The OTel SDK deps are required lazily so importing this module is cheap:
 * without OTEL_EXPORTER_OTLP_ENDPOINT nothing heavy is loaded (tests, local
 * runs without Tempo) and `require('@strafor/node-common')` stays fast.
 * @param {{ serviceName?: string }} opts
 */
function startTracing(opts = {}) {
    if (started) return;
    started = true;

    const serviceName = opts.serviceName || process.env.SERVICE_NAME || 'strafor-service';
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const sampler = process.env.OTEL_TRACES_SAMPLER || 'parentbased_traceidratio';
    const samplerArg = process.env.OTEL_TRACES_SAMPLER_ARG || '0.2';

    // If no endpoint is configured, skip tracing (services can run without Tempo).
    if (!endpoint) {
        return;
    }

    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { resourceFromAttributes } = require('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

    const exporter = new OTLPTraceExporter({
        url: endpoint + '/v1/traces'
    });

    const sdk = new NodeSDK({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: serviceName,
            [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.1.0'
        }),
        traceExporter: exporter,
        instrumentations: [
            getNodeAutoInstrumentations({
                // Disable fs instrumentation (noise) and dns (high cardinality)
                '@opentelemetry/instrumentation-fs': { enabled: false },
                '@opentelemetry/instrumentation-dns': { enabled: false },
                // Exclude health/metrics from tracing
                '@opentelemetry/instrumentation-http': {
                    ignoreIncomingRequestHook: (req) => {
                        const url = req.url || '';
                        return (
                            url.startsWith('/health') ||
                            url.startsWith('/ready') ||
                            url.startsWith('/metrics') ||
                            url.startsWith('/api/health')
                        );
                    }
                }
            })
        ]
    });

    sdk.start();

    // Graceful shutdown
    const shutdown = () => sdk.shutdown().catch(() => {});
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

module.exports = { startTracing };
