import crypto from 'node:crypto';
import type { ServiceConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';

export const TEST_DB = process.env.TEST_DATABASE_URL;
export const TEST_REDIS = process.env.TEST_REDIS_URL;

let cachedKeys: { priv: string; pub: string } | null = null;

/** Generate (once) an RSA-2048 pair for tests. */
export function testKeys(): { priv: string; pub: string } {
    if (!cachedKeys) {
        const pair = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        cachedKeys = { priv: pair.privateKey, pub: pair.publicKey };
    }
    return cachedKeys;
}

export function testConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
    const { priv, pub } = testKeys();
    return loadConfig(
        {},
        {
            port: 0,
            nodeEnv: 'test',
            databaseUrl: TEST_DB || 'postgres://test:test@127.0.0.1:1/nonexistent',
            jwtPrivateKey: priv,
            jwtPublicKey: pub,
            settingsEncryptionKey: crypto.randomBytes(32),
            publicBaseUrl: 'http://localhost:8080',
            ...(TEST_REDIS ? { redisUrl: TEST_REDIS } : {}),
            pgConnTimeoutMs: 1000,
            ...overrides
        }
    );
}

export function uniqueEmail(prefix = 'user'): string {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}@test.local`;
}

export const STRONG_PASSWORD = 'Str0ng!Pass';
