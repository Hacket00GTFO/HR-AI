import { requireEnv } from '@strafor/node-common';
import { z } from 'zod';

const configSchema = z.object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3012),
    LOG_LEVEL: z.string().optional(),
    SERVICE_NAME: z.string().default('payroll-adapter'),

    DATABASE_URL: z.string().url(),

    // Shared secret other services present via X-Service-Token.
    SERVICE_AUTH_TOKEN: z.string().min(8),

    // Optional — when absent the service still works; events are skipped.
    RABBITMQ_URL: z.string().optional(),
    RABBITMQ_EXCHANGE: z.string().default('domain.events'),

    // file_generic adapter drop dir + generated export output dir.
    IMPORTS_DIR: z.string().min(1).default('./payroll_imports'),
    EXPORTS_DIR: z.string().min(1).default('./payroll_exports')
});

export type ServiceConfig = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ServiceConfig {
    return requireEnv(configSchema, source);
}
