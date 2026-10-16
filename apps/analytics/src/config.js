// Environment config — validated at boot via @strafor/node-common requireEnv
// (fail fast, no insecure defaults).
const { requireEnv } = require('@strafor/node-common');
const { z } = require('zod');

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3008),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('analytics'),

    DATABASE_URL: z.string().url(),

    // Shared secret other services present via X-Service-Token.
    SERVICE_AUTH_TOKEN: z.string().min(8),

    // Domain events (optional — consumer retries in background when absent).
    RABBITMQ_URL: z.string().optional(),
    RABBITMQ_EXCHANGE: z.string().default('domain.events')
});

function loadConfig(source = process.env) {
    return requireEnv(configSchema, source);
}

module.exports = { loadConfig };
