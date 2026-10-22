import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { testConfig, testKeys } from './helpers.js';
import { encryptField, decryptField, encryptSecrets, decryptSecrets, maskSecrets, isEncrypted } from '../src/crypto.js';
import { passwordPolicyOk } from '../src/passwords.js';
import { parseDurationSeconds } from '../src/config.js';

// These tests run WITHOUT a database — the pool is pointed at a dead address
// so DB-touching endpoints 5xx quickly instead of hanging.

let app: Express;

beforeAll(async () => {
    // Always a dead address — even when TEST_DATABASE_URL is set for the
    // integration suite, this file exercises the db-down paths.
    const { app: a } = await createApp(testConfig({ databaseUrl: 'postgres://test:test@127.0.0.1:1/nonexistent' }));
    app = a;
});

describe('crypto (AES-256-GCM)', () => {
    it('encrypts and decrypts a field round-trip', () => {
        const key = Buffer.alloc(32, 7);
        const enc = encryptField('super-secret', key);
        expect(isEncrypted(enc)).toBe(true);
        expect(enc).not.toContain('super-secret');
        expect(decryptField(enc, key)).toBe('super-secret');
    });

    it('encrypts only secret-looking keys in a blob', () => {
        const key = Buffer.alloc(32, 9);
        const blob = { clientId: 'abc', clientSecret: 'shh', apiKey: 'k1' };
        const enc = encryptSecrets(blob, key) as Record<string, string>;
        expect(enc['clientId']).toBe('abc');
        expect(isEncrypted(enc['clientSecret'])).toBe(true);
        expect(isEncrypted(enc['apiKey'])).toBe(true);
        const dec = decryptSecrets(enc, key) as Record<string, string>;
        expect(dec['clientSecret']).toBe('shh');
        expect(dec['apiKey']).toBe('k1');
    });

    it('maskSecrets returns ********+last4, never plaintext', () => {
        const key = Buffer.alloc(32, 9);
        const blob = { clientId: 'abc', clientSecret: 'super-secret-value', apiKey: '' };
        const enc = encryptSecrets(blob, key) as Record<string, string>;
        const masked = maskSecrets(enc, key) as Record<string, string>;
        expect(masked['clientId']).toBe('abc'); // non-secret passes through
        expect(masked['clientSecret']).toBe('********alue');
        expect(masked['clientSecret']).not.toContain('super-secret-value');
        expect(masked['apiKey']).toBe(''); // empty stays empty

        // Also masks secrets stored as legacy plaintext (not yet encrypted).
        const plain = maskSecrets({ apiSecret: 'plaintextsecret' }, key) as Record<string, string>;
        expect(plain['apiSecret']).toBe('********cret');
    });
});

describe('password policy', () => {
    it('rejects short passwords', () => {
        expect(passwordPolicyOk('Ab1!')).toBe(false);
    });
    it('rejects single-class passwords', () => {
        expect(passwordPolicyOk('abcdefgh')).toBe(false);
        expect(passwordPolicyOk('12345678')).toBe(false);
    });
    it('accepts mixed-class passwords', () => {
        expect(passwordPolicyOk('Str0ng!Pass')).toBe(true);
        expect(passwordPolicyOk('lowerUPPER123')).toBe(true);
    });
});

describe('config', () => {
    it('parses durations', () => {
        expect(parseDurationSeconds('15m', 0)).toBe(900);
        expect(parseDurationSeconds('7d', 0)).toBe(604800);
        expect(parseDurationSeconds('90', 0)).toBe(90);
        expect(parseDurationSeconds(undefined, 42)).toBe(42);
    });
    it('loads keys from PEM env', async () => {
        const { priv, pub } = testKeys();
        const { loadKeys } = await import('../src/keys.js');
        const set = await loadKeys(testConfig({ jwtPrivateKey: priv, jwtPublicKey: pub }));
        expect(set.kid).toMatch(/^[0-9a-f]{16}$/);
        expect(set.publicJwk.kty).toBe('RSA');
        expect(set.publicJwk.alg).toBe('RS256');
    });
});

describe('http surface (no db)', () => {
    it('GET /health → 200', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.service).toBe('identity-auth');
    });

    it('GET /ready → 503 when db is down', async () => {
        const res = await request(app).get('/ready');
        expect(res.status).toBe(503);
        expect(res.body.checks.db).toBe('down');
    });

    it('GET /.well-known/jwks.json exposes the public JWK', async () => {
        const res = await request(app).get('/.well-known/jwks.json');
        expect(res.status).toBe(200);
        expect(res.body.keys).toHaveLength(1);
        expect(res.body.keys[0].kty).toBe('RSA');
        expect(res.body.keys[0].kid).toBeTruthy();
        expect(res.body.keys[0].n).toBeTruthy();
        expect(res.body.keys[0].d).toBeUndefined(); // public only
    });

    it('protected routes → 401 without token', async () => {
        for (const [method, path] of [
            ['get', '/v1/users'],
            ['post', '/v1/auth/logout'],
            ['post', '/v1/auth/register'],
            ['get', '/v1/settings'],
            ['put', '/v1/settings/integrations']
        ] as const) {
            const res = await (request(app) as any)[method](path).send({});
            expect(res.status).toBe(401);
        }
    });

    it('protected routes → 401 with garbage token', async () => {
        const res = await request(app).get('/v1/users').set('Authorization', 'Bearer not.a.jwt');
        expect(res.status).toBe(401);
    });

    it('login validation → 400 on bad body', async () => {
        const res = await request(app).post('/v1/auth/login').send({ email: 'not-an-email' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
        expect(res.body.details).toBeInstanceOf(Array);
    });

    it('introspect → 400 without token, active:false for bad token', async () => {
        const res = await request(app).get('/v1/auth/introspect');
        expect(res.status).toBe(400);
        const res2 = await request(app).get('/v1/auth/introspect?token=garbage');
        expect(res2.body.active).toBe(false);
    });

    it('echoes a correlation id', async () => {
        const res = await request(app).get('/health').set('X-Correlation-Id', 'corr-123');
        expect(res.headers['x-correlation-id']).toBe('corr-123');
    });
});

describe('mfa http surface (no db)', () => {
    it('POST /v1/auth/mfa/verify → 400 on missing fields', async () => {
        const res = await request(app).post('/v1/auth/mfa/verify').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
    });

    it('POST /v1/auth/mfa/verify → 400 when neither code type is given', async () => {
        const res = await request(app).post('/v1/auth/mfa/verify').send({ challenge_token: 'x.y.z' });
        expect(res.status).toBe(400);
    });

    it('POST /v1/auth/mfa/verify → 401 on garbage challenge token', async () => {
        const res = await request(app)
            .post('/v1/auth/mfa/verify')
            .send({ challenge_token: 'garbage', totp_code: '123456' });
        expect(res.status).toBe(401);
    });

    it('enrollment routes stay behind auth', async () => {
        for (const path of ['/v1/auth/mfa/setup', '/v1/auth/mfa/confirm', '/v1/auth/mfa/disable']) {
            const res = await request(app).post(path).send({});
            expect(res.status).toBe(401);
        }
    });
});

describe('totp helpers', () => {
    it('generateTotp + verifyTotp round-trip a known secret', async () => {
        const { generateTotp, verifyTotp, generateTotpSecret, generateRecoveryCodes } = await import('../src/totp.js');
        const secret = 'JBSWY3DPEHPK3PXP';
        const code = generateTotp(secret);
        expect(code).toMatch(/^\d{6}$/);
        expect(verifyTotp(secret, code)).toBe(true);
        expect(verifyTotp(secret, 'abcdef')).toBe(false);
        expect(verifyTotp(secret, '12345')).toBe(false);
        expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
        const codes = generateRecoveryCodes();
        expect(codes).toHaveLength(8);
        expect(new Set(codes).size).toBe(8);
    });
});

describe('oidc config validation', () => {
    it('is disabled by default and login/callback return 501', async () => {
        const login = await request(app).get('/v1/auth/oidc/login');
        expect(login.status).toBe(501);
        const cb = await request(app).get('/v1/auth/oidc/callback');
        expect(cb.status).toBe(501);
    });

    it('throws on partial OIDC config', async () => {
        const { loadConfig } = await import('../src/config.js');
        expect(() => loadConfig({ OIDC_CLIENT_ID: 'x' })).toThrow(/OIDC/);
    });

    it('accepts a complete OIDC config and defaults the redirect URI', async () => {
        const { loadConfig } = await import('../src/config.js');
        const cfg = loadConfig({
            OIDC_ISSUER: 'http://localhost:8081/realms/strafor',
            OIDC_CLIENT_ID: 'strafor-web',
            OIDC_CLIENT_SECRET: 'dev-secret',
            PUBLIC_BASE_URL: 'http://localhost:3001'
        });
        expect(cfg.oidcIssuer).toBe('http://localhost:8081/realms/strafor');
        expect(cfg.oidcRedirectUri).toBe('http://localhost:3001/v1/auth/oidc/callback');
    });

    it('rejects a non-URL issuer', async () => {
        const { loadConfig } = await import('../src/config.js');
        expect(() => loadConfig({ OIDC_ISSUER: 'not a url', OIDC_CLIENT_ID: 'x' })).toThrow(/OIDC_ISSUER/);
    });
});
