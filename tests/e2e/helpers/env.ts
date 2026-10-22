// Environment / topology resolution for the cross-service E2E suite.
//
// Two access layers are exercised:
//   - GATEWAY layer: every request goes through E2E_BASE_URL (default
//     http://localhost:8081) exactly like a real client. JWT required on
//     /api/v1/** except the public allowlist.
//   - DIRECT layer: business services are hit on their compose-published
//     localhost ports, simulating an internal caller AFTER the gateway has
//     authenticated a user (X-User-Id/X-User-Role headers) or a trusted
//     service caller (X-Service-Token). This is the only way to exercise
//     roles identity-auth cannot issue (employee/manager/candidate — the
//     users table CHECK constraint admits only 'admin'/'hr').
//
// Configuration (all optional — sensible compose defaults):
//   E2E_BASE_URL                 gateway base (default http://localhost:8081)
//   E2E_SERVICE_TOKEN            shared SERVICE_AUTH_TOKEN (falls back to the
//                                repo-root .env value when present)
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD     seeded admin credentials
//   E2E_HR_EMAIL / E2E_HR_PASSWORD           seeded hr credentials
//   E2E_IDENTITY_DATABASE_URL    used by scripts/seed.mjs
//   E2E_<SERVICE>_URL            per-service direct base override
//   E2E_TEST_PRIVATE_KEY[_FILE] / E2E_TEST_PUBLIC_KEY[_FILE]
//                                RS256 pair for helpers/token.ts mintRs256 —
//                                only validates when identity-auth is running
//                                with the same key material (JWT_PRIVATE_KEY/
//                                JWT_PUBLIC_KEY) so its JWKS endpoint serves
//                                the matching public key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(E2E_DIR, '..', '..');
/** Per-test-file JSONL result records consumed by scripts/gen-matrix-doc.mjs. */
export const RESULTS_DIR = path.join(E2E_DIR, '.results');

/** Minimal .env parser — enough for KEY=value lines, no dep required. */
export function loadDotEnv(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m || !m[1]) continue;
        let v = (m[2] ?? '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        out[m[1]] = v;
    }
    return out;
}

const rootEnv = loadDotEnv(path.join(REPO_ROOT, '.env'));

function pick(envName: string, fallback: string): string {
    return process.env[envName] ?? rootEnv[envName] ?? fallback;
}

function stripSlash(u: string): string {
    return u.replace(/\/+$/, '');
}

export const config = {
    /** Gateway base URL — the perimeter under test. */
    baseUrl: stripSlash(pick('E2E_BASE_URL', 'http://localhost:8081')),
    /** Shared service-to-service token (never exposed to real clients). */
    serviceToken: process.env.E2E_SERVICE_TOKEN ?? rootEnv['SERVICE_AUTH_TOKEN'],
    /** Seeded identity users — see scripts/seed.mjs. */
    users: {
        admin: {
            email: pick('E2E_ADMIN_EMAIL', 'e2e.admin@strafor.test'),
            password: pick('E2E_ADMIN_PASSWORD', 'E2e-Test!234')
        },
        hr: {
            email: pick('E2E_HR_EMAIL', 'e2e.hr@strafor.test'),
            password: pick('E2E_HR_PASSWORD', 'E2e-Test!234')
        }
    },
    /** Identity DB for seeding (compose publishes postgres on 127.0.0.1:5433). */
    identityDbUrl:
        process.env['E2E_IDENTITY_DATABASE_URL'] ??
        `postgres://${rootEnv['POSTGRES_USER'] ?? 'strafor'}:${rootEnv['POSTGRES_PASSWORD'] ?? 'postgres'}@localhost:5433/strafor_identity`,
    /** Direct-to-service bases (compose published ports). */
    services: {
        api: stripSlash(pick('E2E_API_URL', 'http://localhost:3000')),
        identity: stripSlash(pick('E2E_IDENTITY_URL', 'http://localhost:3015')),
        hrCore: stripSlash(pick('E2E_HR_CORE_URL', 'http://localhost:3013')),
        timeAttendance: stripSlash(pick('E2E_TIME_ATTENDANCE_URL', 'http://localhost:3011')),
        payroll: stripSlash(pick('E2E_PAYROLL_ADAPTER_URL', 'http://localhost:3012')),
        hrServices: stripSlash(pick('E2E_HR_SERVICES_URL', 'http://localhost:3014')),
        documents: stripSlash(pick('E2E_DOCUMENTS_URL', 'http://localhost:3004')),
        recruitment: stripSlash(pick('E2E_RECRUITMENT_URL', 'http://localhost:3009')),
        notifications: stripSlash(pick('E2E_NOTIFICATIONS_URL', 'http://localhost:3007')),
        aiMatching: stripSlash(pick('E2E_AI_MATCHING_URL', 'http://localhost:3005')),
        analytics: stripSlash(pick('E2E_ANALYTICS_URL', 'http://localhost:3008'))
    } as const,
    /** Optional RS256 pair for test-key token minting (helpers/token.ts). */
    testKeys: {
        privateKey: process.env['E2E_TEST_PRIVATE_KEY'] ?? readIfExists(process.env['E2E_TEST_PRIVATE_KEY_FILE']),
        publicKey: process.env['E2E_TEST_PUBLIC_KEY'] ?? readIfExists(process.env['E2E_TEST_PUBLIC_KEY_FILE'])
    }
};

export type ServiceKey = keyof typeof config.services;

function readIfExists(file: string | undefined): string | undefined {
    if (!file) return undefined;
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

/** True when `base` answers /health (any status < 500 counts as reachable).
 *  Docker Desktop's port proxy stalls connections in multi-second bursts, so
 *  the probe keeps trying for ~45s before declaring a service down — a false
 *  negative skips a whole case block and hides real regressions. */
export async function reachable(base: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + 45_000;
    for (;;) {
        try {
            const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
            return res.status < 500;
        } catch {
            if (Date.now() >= deadline) return false;
            await new Promise((r) => setTimeout(r, 750));
        }
    }
}

const probes = new Map<string, Promise<boolean>>();

/** Memoized liveness probe — safe to call from many tests. */
export function live(base: string): Promise<boolean> {
    let p = probes.get(base);
    if (!p) {
        p = reachable(base);
        probes.set(base, p);
    }
    return p;
}

export function liveGateway(): Promise<boolean> {
    return live(config.baseUrl);
}

export function liveService(key: ServiceKey): Promise<boolean> {
    return live(config.services[key]);
}
