import { z } from 'zod';

// Runtime-validated server env (see also the build-time check in
// next.config.ts). All backend traffic flows through BFF route handlers, so
// these are server-only — nothing here is NEXT_PUBLIC_*.
const envSchema = z.object({
    API_URL: z.url().default('http://localhost:3000'),
    GATEWAY_URL: z.url().optional(),
    AUTH_MODE: z.enum(['legacy', 'v1']).default('legacy'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
});

export const env = envSchema.parse({
    API_URL: process.env.API_URL,
    GATEWAY_URL: process.env.GATEWAY_URL || undefined,
    AUTH_MODE: process.env.AUTH_MODE,
    NODE_ENV: process.env.NODE_ENV
});
