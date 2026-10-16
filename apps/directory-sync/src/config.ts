import { requireEnv } from '@strafor/node-common';
import { z } from 'zod';

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3016),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('directory-sync'),

    // Direct read access to the identity DB (strafor_identity.users) — the
    // source of truth for user display names/emails. Chosen over an HTTP
    // endpoint because identity-auth exposes no internal users list.
    IDENTITY_DATABASE_URL: z.string().url(),

    // Shared secret presented as X-Service-Token on every outbound call.
    SERVICE_AUTH_TOKEN: z.string().min(8),

    // Sync targets (compose-internal URLs).
    RECRUITMENT_CORE_URL: z.string().url().default('http://recruitment-core:3009'),
    HR_CORE_URL: z.string().url().default('http://hr-core:3010'),
    HR_SERVICES_URL: z.string().url().default('http://hr-services:3014'),

    // Worker loop tuning.
    SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    // Target schemas accept at most 500 rows per bulk upsert.
    SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(500),
    SYNC_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    // Exponential backoff per step/batch: base * 2^(attempt-1).
    SYNC_RETRY_MAX: z.coerce.number().int().min(0).default(3),
    SYNC_RETRY_BASE_MS: z.coerce.number().int().min(0).default(500)
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ServiceConfig {
    return requireEnv(configSchema, source);
}
