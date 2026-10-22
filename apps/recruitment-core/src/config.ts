import { requireEnv } from '@strafor/node-common';
import { z } from 'zod';

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3009),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('recruitment-core'),

    DATABASE_URL: z.string().url(),

    // ai-matching: /v1/score + /v1/vacancies/:id/rank + /v1/jobs/:id.
    // Optional — top-candidates / process-feedback return 503 when unset.
    AI_SERVICE_URL: z.string().optional(),
    // Minimum score a candidate needs to appear in /top-candidates.
    AI_MIN_MATCH_SCORE: z.coerce.number().min(0).max(1).default(0.35),

    // documents-resumes: resume uploads + presigned downloads.
    // Optional — resume upload/download return 503 when unset (the legacy
    // RESUMES_DIR fallback still applies for old rows).
    DOCUMENTS_URL: z.string().optional(),

    // Shared secret: presented as X-Service-Token on outbound calls and
    // accepted from trusted service callers (X-Service-Token auth).
    SERVICE_AUTH_TOKEN: z.string().min(8),

    // Synthetic staff identity presented to documents-resumes when the caller
    // has no gateway user (anonymous POST /v1/public/apply resume upload).
    // documents-resumes only checks header presence (X-User-Id positive int +
    // X-User-Role non-empty); it does not resolve the id.
    SERVICE_CALLER_USER_ID: z.coerce.number().int().positive().default(1),

    // Legacy local-storage fallback for pre-extraction resume files.
    RESUMES_DIR: z.string().optional(),

    // Optional — when absent the service still works; events accumulate in
    // outbox_events until a broker is configured.
    RABBITMQ_URL: z.string().optional(),
    RABBITMQ_EXCHANGE: z.string().default('domain.events'),
    OUTBOX_POLL_MS: z.coerce.number().int().positive().default(15000),

    MAX_UPLOAD_BYTES: z.coerce
        .number()
        .int()
        .positive()
        .default(5 * 1024 * 1024), // legacy resume limit: 5MB

    PUBLIC_APPLY_RATE_MAX: z.coerce.number().int().positive().default(20),
    PUBLIC_APPLY_RATE_WINDOW_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(60 * 60 * 1000)
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ServiceConfig {
    return requireEnv(configSchema, source);
}
