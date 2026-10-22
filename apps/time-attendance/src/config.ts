import { requireEnv } from '@strafor/node-common';
import { z } from 'zod';

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3011),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('time-attendance'),

    DATABASE_URL: z.string().url(),

    // Shared secret other services present via X-Service-Token.
    // Guards the internal POST /v1/leave/accrue endpoint.
    SERVICE_AUTH_TOKEN: z.string().min(8),

    // Optional — when absent the service still works; events are skipped.
    RABBITMQ_URL: z.string().optional(),
    RABBITMQ_EXCHANGE: z.string().default('domain.events')
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ServiceConfig {
    return requireEnv(configSchema, source);
}
