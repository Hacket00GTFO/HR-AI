import 'dotenv/config';
import crypto from 'node:crypto';

/** Parse '15m' / '7d' / '1h' / '900' style durations to seconds. */
export function parseDurationSeconds(value: string | undefined, fallbackSeconds: number): number {
    if (!value) return fallbackSeconds;
    const m = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim());
    if (!m) return fallbackSeconds;
    const n = Number(m[1]);
    const unit = m[2] ?? 's';
    const mult = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    return n * mult;
}

export interface ServiceConfig {
    port: number;
    nodeEnv: string;
    databaseUrl: string;
    redisUrl?: string;
    /** PEM strings (may contain literal '\n' escapes from .env files). */
    jwtPrivateKey?: string;
    jwtPublicKey?: string;
    jwtPrivateKeyFile?: string;
    jwtPublicKeyFile?: string;
    /** Dev/CI escape hatch: ephemeral in-memory keypair. */
    generateKeys: boolean;
    accessTokenTtlSeconds: number;
    refreshTokenTtlDays: number;
    issuer: string;
    /** AES-256-GCM key (32 bytes) for settings secrets; undefined disables writes. */
    settingsEncryptionKey?: Buffer;
    rabbitmqUrl?: string;
    notificationsUrl?: string;
    /** Shared service-to-service token for calling internal services. */
    serviceAuthToken?: string;
    /** Base URL used to build password-reset links. */
    publicBaseUrl: string;
    /** Lifetime of the MFA challenge token issued between password and TOTP. */
    mfaChallengeTtlSeconds: number;
    /**
     * OIDC / SSO (dev plumbing — Keycloak in infra/compose, profile `sso`).
     * All-or-nothing: setting any OIDC_* var requires OIDC_ISSUER and
     * OIDC_CLIENT_ID. OIDC_CLIENT_SECRET is optional (public clients);
     * OIDC_REDIRECT_URI defaults to `${PUBLIC_BASE_URL}/v1/auth/oidc/callback`.
     */
    oidcIssuer?: string;
    oidcClientId?: string;
    oidcClientSecret?: string;
    oidcRedirectUri?: string;
    pgPoolMax: number;
    pgConnTimeoutMs: number;
}

function unescapePem(pem: string | undefined): string | undefined {
    if (!pem) return undefined;
    return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

function decodeKeyMaterial(value: string | undefined): Buffer | undefined {
    if (!value) return undefined;
    const buf = Buffer.from(value, 'base64');
    if (buf.length !== 32) {
        // Also accept 64-char hex.
        const hex = Buffer.from(value, 'hex');
        if (hex.length === 32) return hex;
        throw new Error('SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64 or hex encoded)');
    }
    return buf;
}

/** Load config from env. `overrides` win — used by tests. */
export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
    overrides: Partial<ServiceConfig> = {}
): ServiceConfig {
    const cfg: ServiceConfig = {
        port: Number(env.PORT) || 3001,
        nodeEnv: env.NODE_ENV || 'development',
        databaseUrl: env.DATABASE_URL || '',
        ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
        ...(unescapePem(env.JWT_PRIVATE_KEY) ? { jwtPrivateKey: unescapePem(env.JWT_PRIVATE_KEY)! } : {}),
        ...(unescapePem(env.JWT_PUBLIC_KEY) ? { jwtPublicKey: unescapePem(env.JWT_PUBLIC_KEY)! } : {}),
        ...(env.JWT_PRIVATE_KEY_FILE ? { jwtPrivateKeyFile: env.JWT_PRIVATE_KEY_FILE } : {}),
        ...(env.JWT_PUBLIC_KEY_FILE ? { jwtPublicKeyFile: env.JWT_PUBLIC_KEY_FILE } : {}),
        generateKeys: (env.JWT_GENERATE_KEYS || '').toLowerCase() === 'true',
        accessTokenTtlSeconds: parseDurationSeconds(env.ACCESS_TOKEN_TTL || env.JWT_EXPIRES_IN, 15 * 60),
        refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS) || 7,
        issuer: env.JWT_ISSUER || 'strafor-identity',
        ...(decodeKeyMaterial(env.SETTINGS_ENCRYPTION_KEY)
            ? { settingsEncryptionKey: decodeKeyMaterial(env.SETTINGS_ENCRYPTION_KEY)! }
            : {}),
        ...(env.RABBITMQ_URL ? { rabbitmqUrl: env.RABBITMQ_URL } : {}),
        ...(env.NOTIFICATIONS_URL ? { notificationsUrl: env.NOTIFICATIONS_URL } : {}),
        ...(env.SERVICE_AUTH_TOKEN ? { serviceAuthToken: env.SERVICE_AUTH_TOKEN } : {}),
        publicBaseUrl: env.PUBLIC_BASE_URL || 'http://localhost:8080',
        mfaChallengeTtlSeconds: parseDurationSeconds(env.MFA_CHALLENGE_TTL, 5 * 60),
        pgPoolMax: Number(env.PG_POOL_MAX) || 10,
        pgConnTimeoutMs: Number(env.PG_CONN_TIMEOUT_MS) || 5000,
        ...overrides
    };
    applyOidcEnv(cfg, env);
    validateOidcConfig(cfg);
    return cfg;
}

function applyOidcEnv(cfg: ServiceConfig, env: NodeJS.ProcessEnv): void {
    if (cfg.oidcIssuer === undefined && env.OIDC_ISSUER) cfg.oidcIssuer = env.OIDC_ISSUER;
    if (cfg.oidcClientId === undefined && env.OIDC_CLIENT_ID) cfg.oidcClientId = env.OIDC_CLIENT_ID;
    if (cfg.oidcClientSecret === undefined && env.OIDC_CLIENT_SECRET) cfg.oidcClientSecret = env.OIDC_CLIENT_SECRET;
    if (cfg.oidcRedirectUri === undefined && env.OIDC_REDIRECT_URI) cfg.oidcRedirectUri = env.OIDC_REDIRECT_URI;
}

/**
 * OIDC is opt-in: with no OIDC_* env the service behaves exactly as before.
 * A partial config (e.g. client id without issuer) is a hard error — silently
 * half-configured SSO is worse than none.
 */
function validateOidcConfig(cfg: ServiceConfig): void {
    const any = cfg.oidcIssuer || cfg.oidcClientId || cfg.oidcClientSecret || cfg.oidcRedirectUri;
    if (!any) return;
    if (!cfg.oidcIssuer || !cfg.oidcClientId) {
        throw new Error(
            'OIDC requires OIDC_ISSUER and OIDC_CLIENT_ID (OIDC_CLIENT_SECRET optional for public clients)'
        );
    }
    try {
        const url = new URL(cfg.oidcIssuer);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad scheme');
    } catch {
        throw new Error('OIDC_ISSUER must be a valid http(s) URL, e.g. http://localhost:8081/realms/strafor');
    }
    if (!cfg.oidcRedirectUri) {
        cfg.oidcRedirectUri = `${cfg.publicBaseUrl.replace(/\/$/, '')}/v1/auth/oidc/callback`;
    }
}

export { crypto };
