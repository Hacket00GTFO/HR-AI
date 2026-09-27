import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Typed build-time env contract. AUTH_MODE selects which backend surface the
// BFF route handlers talk to: the legacy Express monolith today
// (`API_URL` → /api/*) or the gateway once it lands (`GATEWAY_URL` → /api/v1/*).
const envSchema = z.object({
    API_URL: z.url().default('http://localhost:3000'),
    GATEWAY_URL: z.url().optional(),
    AUTH_MODE: z.enum(['legacy', 'v1']).default('legacy')
});
envSchema.parse({
    API_URL: process.env.API_URL,
    GATEWAY_URL: process.env.GATEWAY_URL || undefined,
    AUTH_MODE: process.env.AUTH_MODE
});

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const isDev = process.env.NODE_ENV === 'development';

// Baseline security headers. CSP stays 'self'-scoped and permissive-safe:
// Next.js hydration streams inline scripts and Grafana dashboards are
// embedded through the same-origin /api/grafana BFF proxy, so no external
// frame/script origins are needed. 'unsafe-eval' is dev-only (HMR).
const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // Same-origin Grafana iframes (admin monitoring) — nothing else frames.
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'self'"
].join('; ');

const securityHeaders = [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // Legacy fallback for agents without CSP frame-ancestors support.
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // geolocation is required for attendance check-in; camera/mic unused.
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' }
];

const nextConfig: NextConfig = {
    output: 'standalone',
    // Monorepo: standalone output must trace deps from the workspace root so
    // pnpm-linked packages are included in .next/standalone.
    outputFileTracingRoot: path.join(__dirname, '..', '..'),
    // `pnpm lint` is the lint gate (turbo task); keeps `next build` lean.
    eslint: { ignoreDuringBuilds: true },
    async headers() {
        return [{ source: '/:path*', headers: securityHeaders }];
    }
};

export default withNextIntl(nextConfig);
