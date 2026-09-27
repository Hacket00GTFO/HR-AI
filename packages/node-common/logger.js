// Structured JSON logger built on pino.
// - LOG_LEVEL env controls verbosity (default: debug in dev, info in prod).
// - SERVICE_NAME env is stamped on every line for multi-service log streams.
// - Sensitive keys are masked in place ([REDACTED]) — the field stays visible
//   in the log so shapes remain greppable, values never leak.
const pino = require('pino');

const REDACT_PATHS = [
    'password',
    '*.password',
    'newPassword',
    '*.newPassword',
    'token',
    '*.token',
    'accessToken',
    '*.accessToken',
    'refreshToken',
    '*.refreshToken',
    'secret',
    '*.secret',
    'clientSecret',
    '*.clientSecret',
    'apiSecret',
    '*.apiSecret',
    'jwt',
    '*.jwt',
    'session',
    '*.session',
    'authorization',
    '*.authorization',
    'req.headers.authorization',
    'req.headers.cookie',
    'apiKey',
    '*.apiKey',
    'api_key',
    '*.api_key',
    'email',
    '*.email'
];

/**
 * Create a pino logger. Options are merged over the StraforAI defaults;
 * `stream` is an optional pino destination (e.g. a Writable for tests).
 */
function createLogger(options = {}, stream) {
    const isProduction = process.env.NODE_ENV === 'production';
    return pino(
        {
            level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
            base: {
                service: process.env.SERVICE_NAME || 'strafor-service',
                env: process.env.NODE_ENV || 'development'
            },
            redact: {
                paths: REDACT_PATHS,
                censor: '[REDACTED]'
            },
            timestamp: pino.stdTimeFunctions.isoTime,
            formatters: {
                level(label) {
                    return { level: label };
                }
            },
            ...options
        },
        stream
    );
}

// Default shared instance — most services just use this.
const logger = createLogger({
    // Inject trace_id and span_id from the active OpenTelemetry span into
    // every log line, enabling Loki → Tempo correlation (derived fields).
    mixin() {
        try {
            const api = require('@opentelemetry/api');
            const span = api.trace.getActiveSpan();
            if (span) {
                const ctx = span.spanContext();
                return { trace_id: ctx.traceId, span_id: ctx.spanId };
            }
        } catch {
            // @opentelemetry/api not loaded — no trace context
        }
        return {};
    }
});

module.exports = { createLogger, logger, REDACT_PATHS };
