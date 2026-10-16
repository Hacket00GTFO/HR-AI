// Gateway proxy tests — real express stubs as upstreams, real HTTP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { SignJWT, exportJWK, importPKCS8, importSPKI, type JWK, type KeyLike } from 'jose';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let identity: Server;
let monolith: Server;
let identityUrl: string;
let monolithUrl: string;
let gateway: Express;
let jwk: JWK;
let privKey: KeyLike;
let kid: string;

/** Last request each stub saw (headers + path). */
const seen: Record<string, { path: string; headers: Record<string, unknown> }> = {};

function echo(req: Request, res: Response): void {
    seen[req.baseUrl + req.path] = { path: req.path, headers: { ...req.headers } };
    res.json({ ok: true, path: req.path, userId: req.headers['x-user-id'] ?? null });
}

beforeAll(async () => {
    // Test RSA keypair + JWKS (served by the identity stub).
    const pair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    privKey = await importPKCS8(pair.privateKey, 'RS256');
    const pubKey = await importSPKI(pair.publicKey, 'RS256');
    jwk = { ...(await exportJWK(pubKey)), kid: 'testkid', alg: 'RS256', use: 'sig' };
    kid = 'testkid';

    const idApp = express();
    idApp.use(express.json());
    idApp.get('/.well-known/jwks.json', (_req, res) => res.json({ keys: [jwk] }));
    idApp.use(echo);
    identity = idApp.listen(0, '127.0.0.1');
    await new Promise((r) => identity.once('listening', r));
    identityUrl = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;

    const monoApp = express();
    monoApp.use(express.json());
    monoApp.use(echo);
    monolith = monoApp.listen(0, '127.0.0.1');
    await new Promise((r) => monolith.once('listening', r));
    monolithUrl = `http://127.0.0.1:${(monolith.address() as AddressInfo).port}`;

    gateway = createApp(
        loadConfig(
            {},
            {
                apiUrl: monolithUrl,
                identityUrl,
                identityJwksUrl: `${identityUrl}/.well-known/jwks.json`,
                proxyTimeoutMs: 3000,
                uploadTimeoutMs: 5000
            }
        )
    );
});

afterAll(() => {
    identity.close();
    monolith.close();
});

async function sign(claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ email: 'u@test.local', role: 'admin', location: { country: 'ES' }, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setSubject('42')
        .setIssuer('strafor-identity')
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(privKey);
}

describe('proxying', () => {
    it('GET /health is served by the gateway itself', async () => {
        const res = await request(gateway).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.service).toBe('gateway');
    });

    it('POST /api/v1/auth/login proxies to identity /v1/auth/login (public)', async () => {
        const res = await request(gateway).post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x' });
        expect(res.status).toBe(200);
        expect(res.body.path).toBe('/v1/auth/login'); // /api prefix stripped
    });

    it('GET /api/v1/users without a token → 401 (never reaches upstream)', async () => {
        const res = await request(gateway).get('/api/v1/users');
        expect(res.status).toBe(401);
    });

    it('GET /api/v1/users with a garbage token → 401', async () => {
        const res = await request(gateway).get('/api/v1/users').set('Authorization', 'Bearer junk');
        expect(res.status).toBe(401);
    });

    it('legacy HS256 token on /api/v1 → 401', async () => {
        const { default: jwt } = await import('jsonwebtoken');
        const t = jwt.sign({ id: 1, role: 'admin' }, 'whatever', { algorithm: 'HS256' });
        const res = await request(gateway).get('/api/v1/users').set('Authorization', `Bearer ${t}`);
        expect(res.status).toBe(401);
    });

    it('valid RS256 token → proxied with X-User-* headers', async () => {
        const token = await sign();
        const res = await request(gateway).get('/api/v1/users').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.userId).toBe('42');
        expect(res.body.path).toBe('/v1/users');
    });

    it('a token signed by a different key → 401', async () => {
        const other = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const otherKey = await importPKCS8(other.privateKey, 'RS256');
        const token = await new SignJWT({ role: 'admin' })
            .setProtectedHeader({ alg: 'RS256', kid: 'otherkid' })
            .setSubject('7')
            .setIssuer('strafor-identity')
            .setJti(crypto.randomUUID())
            .setExpirationTime('15m')
            .sign(otherKey);
        const res = await request(gateway).get('/api/v1/users').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(401);
    });

    it('legacy /api/candidates passes through to the monolith with Authorization untouched', async () => {
        const res = await request(gateway).get('/api/candidates').set('Authorization', 'Bearer legacy-token');
        expect(res.status).toBe(200);
        expect(res.body.path).toBe('/api/candidates');
        expect(seen['/api/candidates']?.headers['authorization']).toBe('Bearer legacy-token');
    });

    it('propagates X-Correlation-Id upstream', async () => {
        const token = await sign();
        await request(gateway)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${token}`)
            .set('X-Correlation-Id', 'corr-xyz');
        expect(seen['/v1/users']?.headers['x-correlation-id']).toBe('corr-xyz');
    });

    it('strips client-supplied X-User-* headers (no spoofing)', async () => {
        const res = await request(gateway).get('/api/candidates').set('X-User-Id', '999').set('X-User-Role', 'admin');
        expect(res.status).toBe(200);
        expect(res.body.userId).toBeNull();
        expect(seen['/api/candidates']?.headers['x-user-id']).toBeUndefined();
    });

    it('upstream down → graceful 502', async () => {
        const dead = createApp(
            loadConfig(
                {},
                {
                    apiUrl: 'http://127.0.0.1:1',
                    identityUrl,
                    identityJwksUrl: `${identityUrl}/.well-known/jwks.json`
                }
            )
        );
        const res = await request(dead).get('/api/candidates');
        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Upstream service unavailable');
    });
});
