// Integration tests — run against real Postgres + Redis.
//   TEST_DATABASE_URL=postgres://postgres:dev@localhost:55432/strafor_identity
//   TEST_REDIS_URL=redis://localhost:56379
// Skipped cleanly when TEST_DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { testConfig, uniqueEmail, STRONG_PASSWORD, TEST_DB } from './helpers.js';
import { runMigrations, query, shutdownDb } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { hashToken } from '../src/tokens.js';
import { shutdownRedis } from '../src/redis.js';
import { shutdownEvents } from '../src/events.js';

const itIfDb = TEST_DB ? it : it.skip;

let app: Express;
let adminToken = '';
let adminRefresh = '';
let adminId = 0;

async function seedAdmin() {
    const email = uniqueEmail('admin');
    const { rows } = await query<{ id: number }>(
        `INSERT INTO users (first_name, last_name, email, password, role)
         VALUES ('Test', 'Admin', $1, $2, 'admin') RETURNING id`,
        [email, await hashPassword(STRONG_PASSWORD)]
    );
    return { id: rows[0]!.id, email };
}

beforeAll(async () => {
    if (!TEST_DB) return;
    const cfg = testConfig();
    const created = await createApp(cfg);
    app = created.app;
    await runMigrations(TEST_DB);
    const admin = await seedAdmin();
    adminId = admin.id;
    const res = await request(app).post('/v1/auth/login').send({ email: admin.email, password: STRONG_PASSWORD });
    expect(res.status).toBe(200);
    adminToken = res.body.accessToken;
    adminRefresh = res.body.refreshToken;
});

afterAll(async () => {
    await shutdownEvents();
    await shutdownRedis();
    await shutdownDb();
});

describe('auth lifecycle (integration)', () => {
    itIfDb('login issues access+refresh tokens and a public user', async () => {
        const email = uniqueEmail('login');
        await query(
            `INSERT INTO users (first_name, last_name, email, password, role)
             VALUES ('L','U',$1,$2,'hr')`,
            [email, await hashPassword(STRONG_PASSWORD)]
        );
        const res = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeTruthy();
        expect(res.body.refreshToken).toBeTruthy();
        expect(res.body.tokenType).toBe('Bearer');
        expect(res.body.user.email).toBe(email);
        expect(res.body.user.password).toBeUndefined();
    });

    itIfDb('login rejects bad credentials with 401', async () => {
        const res = await request(app).post('/v1/auth/login').send({ email: uniqueEmail(), password: 'x' });
        expect(res.status).toBe(401);
    });

    itIfDb('refresh rotates the token and accepts the new one', async () => {
        const res = await request(app).post('/v1/auth/refresh').send({ refreshToken: adminRefresh });
        expect(res.status).toBe(200);
        const rotated = res.body.refreshToken;
        expect(rotated).not.toBe(adminRefresh);
        adminRefresh = rotated; // keep chain valid for later tests

        const res2 = await request(app).post('/v1/auth/refresh').send({ refreshToken: rotated });
        expect(res2.status).toBe(200);
        adminRefresh = res2.body.refreshToken;
    });

    itIfDb('reuse of a rotated refresh token → 401 and family revoked', async () => {
        // fresh login for an isolated family
        const email = uniqueEmail('reuse');
        await query(
            `INSERT INTO users (first_name, last_name, email, password, role)
             VALUES ('R','U',$1,$2,'hr')`,
            [email, await hashPassword(STRONG_PASSWORD)]
        );
        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const t1 = login.body.refreshToken;
        const r1 = await request(app).post('/v1/auth/refresh').send({ refreshToken: t1 });
        expect(r1.status).toBe(200);
        const t2 = r1.body.refreshToken;

        // present t1 again → reuse detection
        const reuse = await request(app).post('/v1/auth/refresh').send({ refreshToken: t1 });
        expect(reuse.status).toBe(401);

        // the legitimate successor t2 must now also be dead (family revoked)
        const dead = await request(app).post('/v1/auth/refresh').send({ refreshToken: t2 });
        expect(dead.status).toBe(401);
    });

    itIfDb('logout blacklists the access token (revoked → 401) and kills refresh', async () => {
        const email = uniqueEmail('logout');
        await query(
            `INSERT INTO users (first_name, last_name, email, password, role)
             VALUES ('O','U',$1,$2,'hr')`,
            [email, await hashPassword(STRONG_PASSWORD)]
        );
        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const at = login.body.accessToken;
        const rt = login.body.refreshToken;

        // token works before logout
        const me = await request(app).get(`/v1/users/${login.body.user.id}`).set('Authorization', `Bearer ${at}`);
        expect(me.status).toBe(200);

        const out = await request(app)
            .post('/v1/auth/logout')
            .set('Authorization', `Bearer ${at}`)
            .send({ refreshToken: rt });
        expect(out.status).toBe(200);
        expect(out.body.status).toBe('logged_out');

        const after = await request(app).get(`/v1/users/${login.body.user.id}`).set('Authorization', `Bearer ${at}`);
        expect(after.status).toBe(401);

        const refresh = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt });
        expect(refresh.status).toBe(401);
    });

    itIfDb('introspect reports active/inactive correctly', async () => {
        const active = await request(app).get('/v1/auth/introspect').set('Authorization', `Bearer ${adminToken}`);
        expect(active.body.active).toBe(true);
        expect(active.body.role).toBe('admin');
        expect(active.body.sub).toBe(String(adminId));
    });
});

describe('users CRUD authz (integration)', () => {
    itIfDb('non-admin cannot list users', async () => {
        const email = uniqueEmail('hr');
        await query(
            `INSERT INTO users (first_name, last_name, email, password, role)
             VALUES ('H','R',$1,$2,'hr')`,
            [email, await hashPassword(STRONG_PASSWORD)]
        );
        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const res = await request(app).get('/v1/users').set('Authorization', `Bearer ${login.body.accessToken}`);
        expect(res.status).toBe(403);
    });

    itIfDb('admin can list, create, update and delete users', async () => {
        const list = await request(app)
            .get('/v1/users?role=admin&page=1&limit=10')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(list.status).toBe(200);
        expect(list.body.pagination.total).toBeGreaterThanOrEqual(1);

        const email = uniqueEmail('created');
        const created = await request(app)
            .post('/v1/users')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                firstName: 'New',
                lastName: 'Hr',
                email,
                password: STRONG_PASSWORD,
                role: 'hr',
                location: { country: 'Spain', city: 'Madrid' }
            });
        expect(created.status).toBe(201);
        const uid = created.body.id;

        const updated = await request(app)
            .put(`/v1/users/${uid}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ firstName: 'Renamed' });
        expect(updated.status).toBe(200);
        expect(updated.body.firstName).toBe('Renamed');

        const del = await request(app).delete(`/v1/users/${uid}`).set('Authorization', `Bearer ${adminToken}`);
        expect(del.status).toBe(200);
    });

    itIfDb('self can read and patch own profile but not role', async () => {
        const email = uniqueEmail('self');
        await query(
            `INSERT INTO users (first_name, last_name, email, password, role)
             VALUES ('S','E',$1,$2,'hr')`,
            [email, await hashPassword(STRONG_PASSWORD)]
        );
        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const at = login.body.accessToken;
        const uid = login.body.user.id;

        const me = await request(app).get(`/v1/users/${uid}`).set('Authorization', `Bearer ${at}`);
        expect(me.status).toBe(200);

        const patch = await request(app)
            .put(`/v1/users/${uid}`)
            .set('Authorization', `Bearer ${at}`)
            .send({ firstName: 'Selfie' });
        expect(patch.status).toBe(200);
        expect(patch.body.firstName).toBe('Selfie');

        const denied = await request(app)
            .put(`/v1/users/${uid}`)
            .set('Authorization', `Bearer ${at}`)
            .send({ role: 'admin' });
        expect(denied.status).toBe(403);
    });
});

describe('password flows (integration)', () => {
    itIfDb('forgot always returns 200; reset consumes the token', async () => {
        const res = await request(app)
            .post('/v1/auth/password/forgot')
            .send({ email: uniqueEmail('ghost') });
        expect(res.status).toBe(200);

        const email = uniqueEmail('reset');
        const { rows } = await query<{ id: number }>(
            `INSERT INTO users (first_name, last_name, email, password, role)
             VALUES ('P','W',$1,$2,'hr') RETURNING id`,
            [email, await hashPassword(STRONG_PASSWORD)]
        );
        const uid = rows[0]!.id;

        const forgot = await request(app).post('/v1/auth/password/forgot').send({ email });
        expect(forgot.status).toBe(200);

        // insert a known reset token (the mailed one is not recoverable)
        const raw = crypto.randomBytes(32).toString('base64url');
        await query(
            `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, now() + interval '1 hour')`,
            [uid, hashToken(raw)]
        );
        const reset = await request(app)
            .post('/v1/auth/password/reset')
            .send({ token: raw, newPassword: 'NewStr0ng!Pass' });
        expect(reset.status).toBe(200);

        // token is single-use
        const again = await request(app)
            .post('/v1/auth/password/reset')
            .send({ token: raw, newPassword: 'OtherPass1!' });
        expect(again.status).toBe(400);

        // new password works
        const login = await request(app).post('/v1/auth/login').send({ email, password: 'NewStr0ng!Pass' });
        expect(login.status).toBe(200);
    });

    itIfDb('change requires current password and revokes sessions', async () => {
        const email = uniqueEmail('change');
        await query(
            `INSERT INTO users (first_name, last_name, email, password, role)
             VALUES ('C','H',$1,$2,'hr')`,
            [email, await hashPassword(STRONG_PASSWORD)]
        );
        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const at = login.body.accessToken;

        const wrong = await request(app)
            .post('/v1/auth/password/change')
            .set('Authorization', `Bearer ${at}`)
            .send({ currentPassword: 'nope', newPassword: 'NewStr0ng!Pass' });
        expect(wrong.status).toBe(400);

        const ok = await request(app)
            .post('/v1/auth/password/change')
            .set('Authorization', `Bearer ${at}`)
            .send({ currentPassword: STRONG_PASSWORD, newPassword: 'NewStr0ng!Pass' });
        expect(ok.status).toBe(200);

        const relogin = await request(app).post('/v1/auth/login').send({ email, password: 'NewStr0ng!Pass' });
        expect(relogin.status).toBe(200);
    });
});

describe('settings (integration)', () => {
    itIfDb('user settings upsert + admin integrations encrypt secrets', async () => {
        const put = await request(app)
            .put('/v1/settings')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ company: { name: 'Strafor', industry: 'HR-tech' }, theme: 'dark' });
        expect(put.status).toBe(200);

        const get = await request(app).get('/v1/settings').set('Authorization', `Bearer ${adminToken}`);
        expect(get.status).toBe(200);
        expect(get.body.company.name).toBe('Strafor');

        const integ = await request(app)
            .put('/v1/settings/integrations')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ linkedin: { clientId: 'id1', clientSecret: 'topsecret', redirectUri: 'https://x/cb' } });
        expect(integ.status).toBe(200);

        // at-rest check: ciphertext in DB, not plaintext
        const { rows } = await query<{ linkedin: Record<string, string> }>(
            'SELECT linkedin FROM settings WHERE user_id IS NULL LIMIT 1'
        );
        expect(rows[0]!.linkedin['clientSecret']).toMatch(/^enc:v1:/);
        expect(rows[0]!.linkedin['clientSecret']).not.toContain('topsecret');

        // admin read is masked — last4 only, never plaintext
        const view = await request(app).get('/v1/settings/integrations').set('Authorization', `Bearer ${adminToken}`);
        expect(view.body.linkedin.clientSecret).toBe('********cret');
        expect(view.body.linkedin.clientId).toBe('id1');
    });
});
