// Standard error helpers for StraforAI services.
// Response contract: { error: string, details?: any } — no stack traces,
// no echoes of submitted data, internals hidden in production.
const { logger } = require('./logger');

/**
 * Create an Error carrying an HTTP status and optional machine-readable details.
 * errorHandler turns it into the standard { error, details } envelope.
 */
function httpError(status, message, details) {
    const err = new Error(message);
    err.status = status;
    if (details !== undefined) err.details = details;
    return err;
}

/**
 * Express error-handling middleware (4-arity). Honors err.status; anything
 * without a valid 4xx/5xx status becomes 500. In production 500s report a
 * generic message; in development the real message is returned for debugging.
 */
// eslint-disable-next-line no-unused-vars -- Express requires the 4-arg signature
function errorHandler(err, req, res, next) {
    const isProduction = process.env.NODE_ENV === 'production';
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
        ? err.status
        : 500;

    const body = {
        error: status === 500
            ? (isProduction ? 'Internal Server Error' : (err.message || 'Internal Server Error'))
            : err.message
    };
    if (status < 500 && err.details !== undefined) {
        body.details = err.details;
    }

    const log = req.log || logger;
    log.error({ err: { message: err.message, status } }, 'request failed');

    res.status(status).json(body);
}

/** 404 helper for unmatched routes. */
function notFound(req, res) {
    res.status(404).json({ error: 'Not found' });
}

module.exports = { httpError, errorHandler, notFound };
