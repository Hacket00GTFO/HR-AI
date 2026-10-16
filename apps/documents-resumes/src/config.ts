import { requireEnv } from '@strafor/node-common';
import { z } from 'zod';

const boolish = (def: 'true' | 'false') =>
    z
        .string()
        .default(def)
        .transform((v) => ['true', '1', 'yes'].includes(v.toLowerCase()));

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3004),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('documents-resumes'),

    DATABASE_URL: z.string().url(),

    MINIO_ENDPOINT: z.string().min(1).default('localhost'),
    MINIO_PORT: z.coerce.number().int().positive().default(9000),
    MINIO_USE_SSL: boolish('false'),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(1),
    MINIO_BUCKET: z.string().min(1).default('strafor-documents'),
    MINIO_AUTOCREATE: boolish('true'),
    // Public endpoint used to build presigned URLs when the S3 client points
    // at an in-cluster host (e.g. `minio:9000` vs `localhost:59000`).
    MINIO_PUBLIC_ENDPOINT: z.string().optional(),

    // Shared secret trusted internal callers present via X-Service-Token.
    // Optional for rollout: when unset, service-token auth is disabled and
    // X-Candidate-Id is never trusted (fail-closed for candidate identity).
    SERVICE_AUTH_TOKEN: z.string().min(8).optional(),

    // Optional — when absent the service still works; events are skipped.
    RABBITMQ_URL: z.string().optional(),
    RABBITMQ_EXCHANGE: z.string().default('domain.events'),

    MAX_UPLOAD_BYTES: z.coerce
        .number()
        .int()
        .positive()
        .default(10 * 1024 * 1024),
    PRESIGN_EXPIRES_SECONDS: z.coerce
        .number()
        .int()
        .positive()
        .default(15 * 60),
    PARSE_VERSION: z.string().default('1'),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(1500),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5)
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ServiceConfig {
    return requireEnv(configSchema, source);
}
