// Shared outbound HTTP client for service-to-service calls.
// - callService: generic — throws ServiceError { code: 'timeout'|'unavailable'|'http_error' }
// - callIdentity: identity-auth specific — returns { status, data }, never throws
// - both forward Authorization + X-Correlation-Id; callService adds X-Service-Token
const { randomUUID } = require('crypto');
const logger = require('./logger');

class ServiceError extends Error {
    constructor(code, message, { status = null, cause = null } = {}) {
        super(message);
        this.name = 'ServiceError';
        this.code = code;
        this.status = status;
        this.cause = cause;
    }
}

/**
 * callService('http://ai-matching:3005', '/v1/score', { method, body, ... })
 * Returns parsed JSON (or null for empty bodies). Throws ServiceError.
 */
async function callService(
    baseUrl,
    path,
    {
        method = 'GET',
        body = undefined,
        timeout = 8000,
        headers = {},
        correlationId = null,
        serviceToken = process.env.SERVICE_AUTH_TOKEN || null
    } = {}
) {
    if (!baseUrl) {
        throw new ServiceError('unavailable', 'service base URL is not configured');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const corrId = correlationId || randomUUID();
    try {
        const resp = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
            method,
            headers: {
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                'X-Correlation-Id': corrId,
                ...(serviceToken ? { 'X-Service-Token': serviceToken } : {}),
                ...headers
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        if (!resp.ok) {
            // Never embed the upstream body: it can carry PII from
            // identity/documents/AI error responses into our logs.
            await resp.text().catch(() => '');
            throw new ServiceError('http_error', `service responded ${resp.status}`, {
                status: resp.status
            });
        }
        if (resp.status === 204) return null;
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) return resp.json();
        return resp.text();
    } catch (err) {
        if (err instanceof ServiceError) throw err;
        if (err.name === 'AbortError') {
            throw new ServiceError('timeout', `service call timed out after ${timeout}ms`, { cause: err });
        }
        throw new ServiceError('unavailable', `service unreachable: ${err.message}`, { cause: err });
    } finally {
        clearTimeout(timer);
    }
}

function identityBaseUrl() {
    return (process.env.IDENTITY_URL || 'http://localhost:3001').replace(/\/$/, '');
}

/**
 * Call the identity-auth service.
 *
 * @param {object} req         inbound Express request (headers forwarded)
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path   path on the identity service, e.g. '/v1/auth/login'
 * @param {object} [opts.body]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{status:number, data:object}>}
 */
async function callIdentity(req, { method = 'GET', path, body, timeoutMs = 8000 } = {}) {
    const url = `${identityBaseUrl()}${path}`;
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };
    if (req && req.headers && req.headers.authorization) {
        headers['Authorization'] = req.headers.authorization;
    }
    const cid = req && (req.correlationId || req.headers['x-correlation-id']);
    if (cid) headers['X-Correlation-Id'] = String(cid);

    try {
        const resp = await fetch(url, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs)
        });
        const text = await resp.text();
        let data;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { error: 'Invalid response from identity service' };
        }
        return { status: resp.status, data };
    } catch (err) {
        logger.error(`identity call failed ${method} ${path}:`, err.message);
        return { status: 502, data: { error: 'Identity service unavailable' } };
    }
}

/**
 * Translate the identity {error, details} envelope to the legacy monolith
 * {message, details} shape so the existing frontend sees no change.
 */
function legacyError(data, fallback = 'Request failed') {
    const out = { message: (data && data.error) || fallback };
    if (data && data.details !== undefined) out.details = data.details;
    return out;
}

/** Add the legacy `_id` alias the frontend still keys on. */
function legacyUser(user) {
    if (!user) return user;
    return { ...user, _id: String(user.id) };
}

module.exports = { callService, ServiceError, callIdentity, legacyError, legacyUser, identityBaseUrl, logger };
