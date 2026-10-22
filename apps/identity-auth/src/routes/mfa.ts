import { Router, type Response } from 'express';
import { logger } from '@strafor/node-common';
import type { RouteDeps } from './auth.js';
import { clientCtx, tokenResponse } from './auth.js';
import { verifyServiceToken, requireAdmin, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as schema from '../schemas.js';
import { query } from '../db.js';
import { findUserById, toPublicUser } from '../users.js';
import { comparePassword } from '../passwords.js';
import { recordAudit } from '../audit.js';
import { issueRefreshToken } from '../refreshTokens.js';
import { signAccessToken, verifyMfaChallengeToken, type MfaChallengeClaims } from '../tokens.js';
import { blacklistJti, isBlacklisted } from '../redis.js';
import {
    TOTP_DIGITS,
    TOTP_STEP_SECONDS,
    generateRecoveryCodes,
    generateTotpSecret,
    hashRecoveryCode,
    verifyTotp
} from '../totp.js';

/**
 * MFA routes. Mounted at /v1/auth/mfa.
 *
 *   POST /setup    (auth)   — generate a pending TOTP secret + otpauth URI
 *   POST /confirm  (auth)   — verify first TOTP → enable MFA, return recovery codes (once)
 *   POST /verify   (public) — exchange {challenge_token, totp_code|recovery_code} for tokens
 *   POST /disable  (auth)   — turn MFA off for self (requires current password)
 *   POST /reset    (admin)  — clear another user's MFA (lost device)
 *   GET  /status   (auth)   — {enabled, hasSecret, recoveryCodesRemaining}
 *
 * The login challenge flow lives in routes/auth.ts: POST /v1/auth/login checks
 * `mfa_enabled` after password verification and returns {mfa_required,
 * challenge_token} instead of tokens; /verify below is the only place a
 * challenge token can be redeemed.
 */
export function mfaRouter(deps: RouteDeps): Router {
    const router = Router();
    const { config, keys, redis } = deps;

    // ---- POST /setup — generate a TOTP secret (pending until /confirm) ----
    router.post('/setup', verifyServiceToken(deps), async (req: AuthenticatedRequest, res: Response) => {
        try {
            const userId = Number(req.auth!.sub);
            const user = await findUserById(userId);
            if (!user) {
                res.status(404).json({ error: 'User not found' });
                return;
            }
            if (user.mfa_enabled) {
                res.status(400).json({ error: 'MFA is already enabled. Use /reset or /disable first.' });
                return;
            }

            const secret = generateTotpSecret();
            await query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, userId]);

            const issuer = encodeURIComponent(deps.config.issuer || 'strafor-identity');
            const account = encodeURIComponent(user.email);
            const qrCodeUrl = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;

            res.json({ secret, qrCodeUrl });
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'mfa setup error');
            res.status(500).json({ error: 'Error setting up MFA' });
        }
    });

    // ---- POST /confirm — verify a TOTP code, enable MFA, return recovery codes once ----
    router.post(
        '/confirm',
        verifyServiceToken(deps),
        validate({ body: schema.mfaConfirmBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const userId = Number(req.auth!.sub);
                const { code } = req.body as { code: string };

                const { rows } = await query<{ mfa_secret: string | null; mfa_enabled: boolean }>(
                    'SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1 AND deleted_at IS NULL',
                    [userId]
                );
                const secret = rows[0]?.mfa_secret;
                if (!secret) {
                    res.status(400).json({ error: 'No MFA secret found. Call /setup first.' });
                    return;
                }

                if (!verifyTotp(secret, code)) {
                    res.status(400).json({ error: 'Invalid MFA code' });
                    return;
                }

                const recoveryCodes = generateRecoveryCodes();
                await query('UPDATE users SET mfa_enabled = true, mfa_backup_codes = $2 WHERE id = $1', [
                    userId,
                    JSON.stringify(recoveryCodes.map(hashRecoveryCode))
                ]);

                await recordAudit({
                    actorId: userId,
                    action: 'mfa.enroll',
                    entity: 'users',
                    entityId: userId
                });

                // Plaintext recovery codes are returned exactly once — only
                // their sha256 hashes are stored.
                res.json({ enabled: true, recoveryCodes });
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'mfa confirm error');
                res.status(500).json({ error: 'Error verifying MFA' });
            }
        }
    );

    // ---- POST /verify — PUBLIC: exchange a login challenge token + code for real tokens ----
    router.post('/verify', validate({ body: schema.mfaChallengeBody }), async (req, res: Response) => {
        const { challenge_token, totp_code, recovery_code } = req.body as {
            challenge_token: string;
            totp_code?: string;
            recovery_code?: string;
        };

        let claims: MfaChallengeClaims;
        try {
            claims = await verifyMfaChallengeToken(challenge_token, keys, config.issuer);
        } catch {
            res.status(401).json({ error: 'Invalid or expired MFA challenge' });
            return;
        }

        // Single-use enforcement when Redis is configured.
        if (claims.jti && (await isBlacklisted(redis, claims.jti))) {
            res.status(401).json({ error: 'Invalid or expired MFA challenge' });
            return;
        }

        try {
            const userId = Number(claims.sub);
            const user = await findUserById(userId);
            if (!user || user.active === false || !user.mfa_enabled || !user.mfa_secret) {
                res.status(401).json({ error: 'Invalid or expired MFA challenge' });
                return;
            }

            let method: 'totp' | 'recovery';
            if (totp_code !== undefined) {
                if (!verifyTotp(user.mfa_secret, totp_code)) {
                    await challengeFail(userId);
                    res.status(401).json({ error: 'Invalid MFA code' });
                    return;
                }
                method = 'totp';
            } else {
                const hashes: string[] = Array.isArray(user.mfa_backup_codes) ? user.mfa_backup_codes : [];
                const presented = hashRecoveryCode(recovery_code ?? '');
                if (!hashes.includes(presented)) {
                    await challengeFail(userId);
                    res.status(401).json({ error: 'Invalid recovery code' });
                    return;
                }
                // One-time: burn the used recovery code.
                await query('UPDATE users SET mfa_backup_codes = $2 WHERE id = $1', [
                    userId,
                    JSON.stringify(hashes.filter((h) => h !== presented))
                ]);
                method = 'recovery';
            }

            // Challenge consumed — blacklist its jti for the remaining TTL.
            const remaining = claims.exp - Math.floor(Date.now() / 1000);
            await blacklistJti(redis, claims.jti, remaining);

            await recordAudit({
                actorId: userId,
                action: 'mfa.challenge_ok',
                entity: 'users',
                entityId: userId,
                metadata: { method }
            });

            await updateLastLogin(userId);
            const accessToken = await signAccessToken(user, keys, config);
            const { token: refreshToken } = await issueRefreshToken(
                user.id,
                config.refreshTokenTtlDays,
                clientCtx(req)
            );

            res.json({
                ...tokenResponse(accessToken, refreshToken, toPublicUser(user), config.accessTokenTtlSeconds),
                mfa_setup_required: false
            });
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'mfa challenge verify error');
            res.status(500).json({ error: 'Error verifying MFA' });
        }
    });

    // ---- POST /disable — disable MFA for self (requires current password) ----
    router.post(
        '/disable',
        verifyServiceToken(deps),
        validate({ body: schema.mfaDisableBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const userId = Number(req.auth!.sub);
                const { password } = req.body as { password: string };

                const user = await findUserById(userId);
                if (!user) {
                    res.status(404).json({ error: 'User not found' });
                    return;
                }

                if (!(await comparePassword(password, user.password))) {
                    res.status(400).json({ error: 'Password is incorrect' });
                    return;
                }

                await clearMfa(userId);
                await recordAudit({
                    actorId: userId,
                    action: 'mfa.reset',
                    entity: 'users',
                    entityId: userId,
                    metadata: { by: 'self' }
                });
                res.json({ enabled: false });
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'mfa disable error');
                res.status(500).json({ error: 'Error disabling MFA' });
            }
        }
    );

    // ---- POST /reset — ADMIN: clear another user's MFA (lost device) ----
    router.post(
        '/reset',
        requireAdmin(deps),
        validate({ body: schema.mfaResetBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const { userId } = req.body as { userId: number };
                const target = await findUserById(userId);
                if (!target) {
                    res.status(404).json({ error: 'User not found' });
                    return;
                }
                await clearMfa(userId);
                await recordAudit({
                    actorId: Number(req.auth!.sub),
                    action: 'mfa.reset',
                    entity: 'users',
                    entityId: userId,
                    metadata: { by: 'admin', actorId: Number(req.auth!.sub) }
                });
                res.json({ enabled: false, userId });
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'mfa reset error');
                res.status(500).json({ error: 'Error resetting MFA' });
            }
        }
    );

    // ---- GET /status — return MFA status for the authenticated user ----
    router.get('/status', verifyServiceToken(deps), async (req: AuthenticatedRequest, res: Response) => {
        try {
            const userId = Number(req.auth!.sub);
            const { rows } = await query<{
                mfa_enabled: boolean;
                mfa_secret: string | null;
                mfa_backup_codes: string[] | null;
            }>('SELECT mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE id = $1 AND deleted_at IS NULL', [
                userId
            ]);
            const row = rows[0];
            if (!row) {
                res.status(404).json({ error: 'User not found' });
                return;
            }
            res.json({
                enabled: !!row.mfa_enabled,
                hasSecret: !!row.mfa_secret,
                recoveryCodesRemaining: Array.isArray(row.mfa_backup_codes) ? row.mfa_backup_codes.length : 0
            });
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'mfa status error');
            res.status(500).json({ error: 'Error fetching MFA status' });
        }
    });

    return router;
}

async function clearMfa(userId: number): Promise<void> {
    await query(
        "UPDATE users SET mfa_secret = NULL, mfa_enabled = false, mfa_backup_codes = '[]'::jsonb WHERE id = $1",
        [userId]
    );
}

async function updateLastLogin(userId: number): Promise<void> {
    await query('UPDATE users SET last_login = now(), logged_out = false WHERE id = $1', [userId]);
}

async function challengeFail(userId: number): Promise<void> {
    await recordAudit({
        actorId: userId,
        action: 'mfa.challenge_fail',
        entity: 'users',
        entityId: userId
    });
}

export default mfaRouter;
