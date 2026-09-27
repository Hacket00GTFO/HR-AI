// Express middleware that assigns every request a correlation id.
// - Honors an inbound X-Correlation-Id header (sanitized, length-capped) so
//   traces propagate across services.
// - Otherwise generates a crypto.randomUUID().
// - Sets req.correlationId, echoes the id on the response header, and
//   attaches req.log — a pino child logger with correlationId bound.
const crypto = require('crypto');
const { logger } = require('./logger');

const CORRELATION_HEADER = 'x-correlation-id';
const MAX_INBOUND_LENGTH = 128;

function sanitizeInbound(value) {
    if (typeof value !== 'string') return null;
    // Strip control characters — ids end up in logs; no ANSI/CRLF injection.
    // eslint-disable-next-line no-control-regex -- intentionally matching control chars
    const clean = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!clean || clean.length > MAX_INBOUND_LENGTH) return null;
    return clean;
}

function correlationId(req, res, next) {
    const inbound = sanitizeInbound(req.get ? req.get(CORRELATION_HEADER) : req.headers[CORRELATION_HEADER]);
    const id = inbound || crypto.randomUUID();

    req.correlationId = id;
    res.setHeader('X-Correlation-Id', id);
    req.log = (req.log || logger).child({ correlationId: id });

    next();
}

module.exports = { correlationId, CORRELATION_HEADER };
