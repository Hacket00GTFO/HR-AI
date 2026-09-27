const { createLogger, logger } = require('./logger');
const { correlationId, CORRELATION_HEADER } = require('./correlationId');
const { httpError, errorHandler, notFound } = require('./errors');
const { requireEnv } = require('./config');
const { createMetrics } = require('./metrics');
const { startTracing } = require('./tracing');
const { observePool } = require('./pgMetrics');
const { createAmqpMetrics } = require('./amqpMetrics');

module.exports = {
    createLogger,
    logger,
    correlationId,
    CORRELATION_HEADER,
    httpError,
    errorHandler,
    notFound,
    requireEnv,
    createMetrics,
    startTracing,
    observePool,
    createAmqpMetrics
};
