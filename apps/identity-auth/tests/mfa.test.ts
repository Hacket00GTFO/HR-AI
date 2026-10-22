// MFA integration tests — run against real Postgres (+ Redis when provided).
//   TEST_DATABASE_URL=postgres://postgres:dev@localhost:55432/strafor_identity
//   TEST_REDIS_URL=redis://localhost:56379
// Skipped cleanly when TEST_DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { testConfig, uniqueEmail, STRONG_PASSWORD, TEST_DB } from './helpers.js';
import { runMigrations, query, shutdownDb } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { generateTotp } from '../src/totp.js';
import { shutdownRedis } from '../src/redis.js';
import { shutdownEvents } from '../src/events.js';

const itIfDb = TEST_DB ? it : it.skip;

let app: Express;

async function seedUser(role: 'admin' | 'hr' = 'hr') {
    const email = uniqueEmail('mfa');
    const { rows } = await query<{ id: number }>(
        `INSERT INTO users (first_name, last_name, email, password, role)
         VALUES ('M','U',$1,$2,$3) RETURNING id`,
        [email, await hashPassword(STRONG_PASSWORD), role]
    );
    return { id: rows[0]!.id, email };
}

beforeAll(async () => {
    if (!TEST_DB) return;
    const created = await createApp(testConfig());
    app = created.app;
    await runMigrations(TEST_DB);
});

afterAll(async () => {
    await shutdownEvents();
    await shutdownRedis();
    await shutdownDb();
});

describe('mfa enforcement (integration)', () => {
    itIfDb('unenrolled user gets tokens + mfa_setup_required flag', async () => {
        const { email } = await seedUser();
        const res = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeTruthy();
        expect(res.body.mfa_setup_required).toBe(true);
        expect(res.body.mfa_required).toBeUndefined();
    });

    itIfDb('enrolled user gets mfa_required challenge instead of tokens', async () => {
        const { id, email } = await seedUser();
        await query(`UPDATE users SET mfa_secret = 'JBSWY3DPEHPK3PXP', mfa_enabled = true WHERE id = $1`, [id]);
        const res = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.mfa_required).toBe(true);
        expect(res.body.challenge_token).toBeTruthy();
        expect(res.body.accessToken).toBeUndefined();
        expect(res.body.refreshToken).toBeUndefined();
    });

    itIfDb('mfa/verify issues tokens with a valid TOTP and rejects an invalid one', async () => {
        const { id, email } = await seedUser();
        const secret = 'JBSWY3DPEHPK3PXP';
        await query(`UPDATE users SET mfa_secret = $2, mfa_enabled = true WHERE id = $1`, [id, secret]);

        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        expect(login.body.mfa_required).toBe(true);
        const challenge = login.body.challenge_token as string;

        // invalid code → 401
        const bad = await request(app)
            .post('/v1/auth/mfa/verify')
            .send({ challenge_token: challenge, totp_code: '000000' });
        // '000000' could theoretically be the real code — assert via a deliberately wrong one
        const realCode = generateTotp(secret);
        if (realCode === '000000') {
            expect(bad.status).toBe(200); // astronomically unlikely
        } else {
            expect(bad.status).toBe(401);
        }

        // valid code → real tokens
        const ok = await request(app)
            .post('/v1/auth/mfa/verify')
            .send({ challenge_token: challenge, totp_code: generateTotp(secret) });
        expect(ok.status).toBe(200);
        expect(ok.body.accessToken).toBeTruthy();
        expect(ok.body.refreshToken).toBeTruthy();
        expect(ok.body.user.email).toBe(email);
        expect(ok.body.mfa_setup_required).toBe(false);
    });

    itIfDb('mfa/verify rejects a garbage challenge token', async () => {
        const res = await request(app)
            .post('/v1/auth/mfa/verify')
            .send({ challenge_token: 'not.a.jwt', totp_code: '123456' });
        expect(res.status).toBe(401);
    });

    itIfDb('mfa/verify rejects an ACCESS token used as a challenge', async () => {
        const { email } = await seedUser();
        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const res = await request(app)
            .post('/v1/auth/mfa/verify')
            .send({ challenge_token: login.body.accessToken, totp_code: '123456' });
        expect(res.status).toBe(401);
    });

    itIfDb('enrollment: setup → confirm returns 8 recovery codes; status reflects them', async () => {
        const { email } = await seedUser();
        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const at = login.body.accessToken as string;

        const setup = await request(app).post('/v1/auth/mfa/setup').set('Authorization', `Bearer ${at}`);
        expect(setup.status).toBe(200);
        const secret = setup.body.secret as string;
        expect(secret).toBeTruthy();
        expect(setup.body.qrCodeUrl).toMatch(/^otpauth:\/\/totp\//);

        const confirm = await request(app)
            .post('/v1/auth/mfa/confirm')
            .set('Authorization', `Bearer ${at}`)
            .send({ code: generateTotp(secret) });
        expect(confirm.status).toBe(200);
        expect(confirm.body.enabled).toBe(true);
        expect(confirm.body.recoveryCodes).toHaveLength(8);
        expect(confirm.body.recoveryCodes[0]).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);

        const status = await request(app).get('/v1/auth/mfa/status').set('Authorization', `Bearer ${at}`);
        expect(status.body.enabled).toBe(true);
        expect(status.body.recoveryCodesRemaining).toBe(8);
    });

    itIfDb('recovery code logs in once, then is burned', async () => {
        const { email } = await seedUser();
        const login = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const at = login.body.accessToken as string;
        const setup = await request(app).post('/v1/auth/mfa/setup').set('Authorization', `Bearer ${at}`);
        const confirm = await request(app)
            .post('/v1/auth/mfa/confirm')
            .set('Authorization', `Bearer ${at}`)
            .send({ code: generateTotp(setup.body.secret) });
        const recoveryCode = confirm.body.recoveryCodes[0] as string;

        // next login → challenge
        const login2 = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        expect(login2.body.mfa_required).toBe(true);

        const ok = await request(app)
            .post('/v1/auth/mfa/verify')
            .send({ challenge_token: login2.body.challenge_token, recovery_code: recoveryCode });
        expect(ok.status).toBe(200);
        expect(ok.body.accessToken).toBeTruthy();

        // same recovery code on a fresh challenge → 401
        const login3 = await request(app).post('/v1/auth/login').send({ email, password: STRONG_PASSWORD });
        const burned = await request(app)
            .post('/v1/auth/mfa/verify')
            .send({ challenge_token: login3.body.challenge_token, recovery_code: recoveryCode });
        expect(burned.status).toBe(401);
    });

    itIfDb('admin reset clears MFA so the next login is mfa_setup_required again', async () => {
        const admin = await seedUser('admin');
        const adminLogin = await request(app)
            .post('/v1/auth/login')
            .send({ email: admin.email, password: STRONG_PASSWORD });
        const adminToken = adminLogin.body.accessToken as string;

        const user = await seedUser();
        await query(`UPDATE users SET mfa_secret = 'JBSWY3DPEHPK3PXP', mfa_enabled = true WHERE id = $1`, [user.id]);

        const reset = await request(app)
            .post('/v1/auth/mfa/reset')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ userId: user.id });
        expect(reset.status).toBe(200);

        const relogin = await request(app)
            .post('/v1/auth/login')
            .send({ email: user.email, password: STRONG_PASSWORD });
        expect(relogin.body.mfa_setup_required).toBe(true);
        expect(relogin.body.mfa_required).toBeUndefined();

        // non-admin cannot reset
        const hrToken = relogin.body.accessToken as string;
        const denied = await request(app)
            .post('/v1/auth/mfa/reset')
            .set('Authorization', `Bearer ${hrToken}`)
            .send({ userId: admin.id });
        expect(denied.status).toBe(403);
    });
});
