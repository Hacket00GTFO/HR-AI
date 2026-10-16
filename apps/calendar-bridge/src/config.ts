import { requireEnv } from '@strafor/node-common';
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3016),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('calendar-bridge'),

    DATABASE_URL: z.string().url(),

    // Shared secret other services present via X-Service-Token.
    SERVICE_AUTH_TOKEN: z.string().min(8),

    // Microsoft 365 / Entra ID app registration (client credentials flow,
    // application permission Calendars.ReadWrite). ALL THREE must be set for
    // the real Graph provider; when any is absent the service runs in
    // deterministic `stub` mode. '' (compose default) means unset.
    // These values are NEVER logged and are masked in every API response.
    M365_TENANT_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    M365_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    M365_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

    // Optional — when absent the service still works; events accumulate in
    // outbox_events until a broker is configured.
    RABBITMQ_URL: z.preprocess(emptyToUndefined, z.string().optional()),
    RABBITMQ_EXCHANGE: z.string().default('domain.events'),
    OUTBOX_POLL_MS: z.coerce.number().int().positive().default(15000)
});

export type ServiceConfig = z.infer<typeof configSchema>;

/** Active calendar provider mode — 'm365' only when the full credential set is configured. */
export function providerMode(config: ServiceConfig): 'm365' | 'stub' {
    return config.M365_TENANT_ID && config.M365_CLIENT_ID && config.M365_CLIENT_SECRET ? 'm365' : 'stub';
}

export function loadConfig(source: Record<string, string | undefined> = process.env): ServiceConfig {
    return requireEnv(configSchema, source);
}
