// Lazily-created shared Redis client (ioredis). Returns null when REDIS_URL
// is unset — callers must handle the no-Redis fallback.
// Used for the identity-auth token blacklist (bl:<jti>).
const { Redis } = require('ioredis');
const logger = require('./logger');

let client = null;
let attempted = false;

function get() {
    if (client) return client;
    if (attempted) return null;
    attempted = true;
    const url = process.env.REDIS_URL;
    if (!url) return null;
    try {
        client = new Redis(url, {
            lazyConnect: false,
            maxRetriesPerRequest: 2,
            retryStrategy: (times) => Math.min(times * 500, 5000)
        });
        client.on('error', (err) => logger.error('Redis error:', err.message));
    } catch (err) {
        logger.error('Redis init failed:', err.message);
        client = null;
    }
    return client;
}

async function shutdown() {
    if (client) {
        const c = client;
        client = null;
        attempted = false;
        c.disconnect();
    }
}

module.exports = { get, shutdown };
