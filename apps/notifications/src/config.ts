import { requireEnv } from '@strafor/node-common';
import { z } from 'zod';

const boolish = (def: 'true' | 'false') =>
    z
        .string()
        .default(def)
        .transform((v) => ['true', '1', 'yes'].includes(v.toLowerCase()));

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3007),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('notifications'),

    DATABASE_URL: z.string().url(),

    SMTP_HOST: z.string().min(1).default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_SECURE: boolish('false'),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().min(1).default('StraforAI <no-reply@strafor.local>'),

    // Shared secret other services present via X-Service-Token.
    SERVICE_AUTH_TOKEN: z.string().min(8),

    RABBITMQ_URL: z.string().optional(),
    RABBITMQ_EXCHANGE: z.string().default('domain.events'),

    // Mailbox for digest-style domain events with no natural recipient
    // (vacancy/payroll/survey digests, attendance anomalies, expense
    // approvals). Unset/empty → those events are skipped with an info log.
    HR_NOTIFY_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()),

    WORKER_POLL_MS: z.coerce.number().int().positive().default(1500),
    RETRY_BASE_MS: z.coerce.number().int().positive().default(5000),
    MAX_ATTEMPTS: z.coerce.number().int().positive().default(5)
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ServiceConfig {
    return requireEnv(configSchema, source);
}
