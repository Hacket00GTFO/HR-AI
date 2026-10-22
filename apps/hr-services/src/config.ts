import { requireEnv } from '@strafor/node-common';
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3014),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('hr-services'),

    DATABASE_URL: z.string().url(),

    // Shared secret other services present via X-Service-Token.
    SERVICE_AUTH_TOKEN: z.string().min(8),

    // HMAC key that pseudonymises survey respondents (respondent_hash).
    // Optional — falls back to SERVICE_AUTH_TOKEN when unset; set a dedicated
    // secret in shared environments. '' (compose default) means unset.
    SURVEY_RESPONDENT_SALT: z.preprocess(emptyToUndefined, z.string().min(16).optional()),

    // k-anonymity threshold for survey aggregates: any group/dimension cell
    // with fewer respondents is suppressed from results.
    SURVEY_MIN_GROUP_SIZE: z.coerce.number().int().min(2).default(5),

    // Ticket SLA defaults, in hours, by priority.
    SLA_CRITICAL_HOURS: z.coerce.number().positive().default(4),
    SLA_HIGH_HOURS: z.coerce.number().positive().default(24),
    SLA_NORMAL_HOURS: z.coerce.number().positive().default(72),
    SLA_LOW_HOURS: z.coerce.number().positive().default(168),

    // Optional — when absent the service still works; events accumulate in
    // outbox_events until a broker is configured.
    RABBITMQ_URL: z.preprocess(emptyToUndefined, z.string().optional()),
    RABBITMQ_EXCHANGE: z.string().default('domain.events'),
    OUTBOX_POLL_MS: z.coerce.number().int().positive().default(15000)
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ServiceConfig {
    return requireEnv(configSchema, source);
}
