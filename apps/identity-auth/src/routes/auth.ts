import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { logger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import type { KeySet } from '../keys.js';
import type { Redis } from 'ioredis';
import { validate } from '../middleware/validate.js';
import {
    bearerToken,
    verifyServiceToken,
    requireAdmin,
    type AuthenticatedRequest,
    type AuthDeps
} from '../middleware/auth.js';
import * as schema from '../schemas.js';
import { findUserByEmail, findUserById, createUser, updateUser, toPublicUser } from '../users.js';
import { issueRefreshToken, rotateRefreshToken, revokeAllForUser, revokeFamilyByToken } from '../refreshTokens.js';
import { signAccessToken, signMfaChallengeToken, hashToken, verifyAccessToken } from '../tokens.js';
import { comparePassword } from '../passwords.js';
import { recordAudit } from '../audit.js';
import { publishEvent, buildEvent } from '../events.js';
import { query, withTransaction } from '../db.js';
import { recordOutboxEvent } from '../outbox.js';
import { blacklistJti, isBlacklisted } from '../redis.js';

export interface RouteDeps extends AuthDeps {
    config: ServiceConfig;
    keys: KeySet;
    redis: Redis | null;
}

export function clientCtx(req: Request): { userAgent?: string; ip?: string } {
    const ua = req.headers['user-agent'];
    return {
        ...(ua ? { userAgent: String(ua).slice(0, 500) } : {}),
        ...(req.ip ? { ip: req.ip } : {})
    };
}

export function tokenResponse(
    accessToken: string,
    refreshToken: string,
    user: ReturnType<typeof toPublicUser>,
    expiresIn: number
) {
    return {
        accessToken,
        refreshToken,
        tokenType: 'Bearer' as const,
        expiresIn,
        user
    };
}

export function authRouter(deps: RouteDeps): Router {
    const router = Router();
    const { config, keys, redis } = deps;

    // ---- POST /v1/auth/login (public, rate-limited at app level) ----
    router.post('/login', validate({ body: schema.loginBody }), async (req: Request, res: Response) => {
        try {
            const { email, password } = req.body as { email: string; password: string };
            const user = await findUserByEmail(email);
            const passwordOk = user ? await comparePassword(password, user.password) : false;
            if (!user || !passwordOk) {
                res.status(401).json({ error: 'Invalid credentials', details: 'Email or password is incorrect' });
                return;
            }
            if (user.active === false) {
                res.status(403).json({ error: 'Account deactivated', details: 'This account has been deactivated' });
                return;
            }

            // MFA gate — mandatory for the whole workforce and role-agnostic,
            // so employee/manager/candidate accounts reuse the same flow:
            // enrolled   → challenge token, NO access token until TOTP verifies
            // unenrolled → tokens + mfa_setup_required flag so the UI forces
            //              the enrollment wizard on first login
            if (user.mfa_enabled && user.mfa_secret) {
                const challengeToken = await signMfaChallengeToken(user, keys, config);
                await recordAudit({
                    actorId: user.id,
                    action: 'auth.login',
                    entity: 'users',
                    entityId: user.id,
                    metadata: { role: user.role, mfa: 'challenge_issued' }
                });
                res.json({
                    mfa_required: true,
                    challenge_token: challengeToken,
                    expires_in: config.mfaChallengeTtlSeconds
                });
                return;
            }

            await updateUser(user.id, { lastLogin: new Date(), loggedOut: false });
            const accessToken = await signAccessToken(user, keys, config);
            const { token: refreshToken } = await issueRefreshToken(
                user.id,
                config.refreshTokenTtlDays,
                clientCtx(req)
            );

            await recordAudit({
                actorId: user.id,
                action: 'auth.login',
                entity: 'users',
                entityId: user.id,
                metadata: { role: user.role }
            });

            res.json({
                ...tokenResponse(accessToken, refreshToken, toPublicUser(user), config.accessTokenTtlSeconds),
                mfa_setup_required: !user.mfa_enabled
            });
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'login error');
            res.status(500).json({ error: 'An error occurred during login' });
        }
    });

    // ---- POST /v1/auth/refresh (public — rotating refresh token) ----
    router.post('/refresh', validate({ body: schema.refreshBody }), async (req: Request, res: Response) => {
        try {
            const { refreshToken } = req.body as { refreshToken: string };
            const result = await rotateRefreshToken(refreshToken, config.refreshTokenTtlDays, clientCtx(req));
            if (!result.ok) {
                const msg =
                    result.reason === 'reused'
                        ? 'Refresh token reuse detected — session revoked'
                        : 'Invalid or expired refresh token';
                res.status(401).json({ error: msg });
                return;
            }
            const user = await findUserById(result.userId);
            if (!user || user.active === false) {
                res.status(401).json({ error: 'Invalid or expired refresh token' });
                return;
            }
            const accessToken = await signAccessToken(user, keys, config);
            res.json(tokenResponse(accessToken, result.token, toPublicUser(user), config.accessTokenTtlSeconds));
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'refresh error');
            res.status(500).json({ error: 'An error occurred during token refresh' });
        }
    });

    // ---- POST /v1/auth/logout (authenticated) ----
    router.post(
        '/logout',
        verifyServiceToken(deps),
        validate({ body: schema.logoutBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const auth = req.auth!;
                const { refreshToken } = req.body as { refreshToken?: string };

                // Blacklist the access token's jti for its remaining lifetime.
                const remaining = auth.exp - Math.floor(Date.now() / 1000);
                await blacklistJti(redis, auth.jti, remaining);

                // Revoke the refresh family (the one the client presents, else all).
                if (refreshToken) {
                    await revokeFamilyByToken(refreshToken);
                } else {
                    await revokeAllForUser(Number(auth.sub));
                }

                // DB fallback flag — used when Redis is not configured.
                await updateUser(Number(auth.sub), { loggedOut: true });

                await recordAudit({
                    actorId: auth.sub,
                    action: 'auth.logout',
                    entity: 'users',
                    entityId: auth.sub
                });
                await publishEvent(
                    config,
                    buildEvent('strafor.user.logged_out', { userId: Number(auth.sub) }, req.correlationId as string)
                );

                res.json({ message: 'Logged out successfully', status: 'logged_out' });
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'logout error');
                res.status(500).json({ error: 'An error occurred during logout' });
            }
        }
    );

    // ---- GET /v1/auth/introspect (internal token validation for services) ----
    router.get('/introspect', async (req: Request, res: Response) => {
        const token = bearerToken(req) || (typeof req.query['token'] === 'string' ? req.query['token'] : null);
        if (!token) {
            res.status(400).json({ error: 'Token required (Authorization header or ?token=)' });
            return;
        }
        try {
            const claims = await verifyAccessToken(token, keys, config.issuer);
            if (claims.jti && (await isBlacklisted(redis, claims.jti))) {
                res.json({ active: false });
                return;
            }
            res.json({
                active: true,
                sub: claims.sub,
                email: claims.email,
                role: claims.role,
                location: claims.location ?? null,
                jti: claims.jti,
                expiresAt: new Date(claims.exp * 1000).toISOString()
            });
        } catch {
            res.json({ active: false });
        }
    });

    // ---- POST /v1/auth/register (admin) ----
    router.post(
        '/register',
        requireAdmin(deps),
        validate({ body: schema.registerBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const { firstName, lastName, email, password, role, location } = req.body;
                if (role === 'hr' && (!location || !location.country || !location.city)) {
                    res.status(400).json({
                        error: 'Missing location information',
                        details: 'Country and city are required for HR accounts'
                    });
                    return;
                }
                if (await findUserByEmail(email)) {
                    res.status(400).json({
                        error: 'Email already registered',
                        details: 'Please use a different email address'
                    });
                    return;
                }

                const user = await withTransaction(async (client) => {
                    const created = await createUser(
                        {
                            firstName,
                            lastName,
                            email,
                            password,
                            role,
                            ...(role === 'hr' ? { location } : {})
                        },
                        client
                    );
                    // Outbox row commits with the user row — relay publishes
                    // strafor.identity.user_created post-commit.
                    await recordOutboxEvent(client, {
                        aggregateType: 'user',
                        aggregateId: created.id,
                        eventType: 'strafor.identity.user_created',
                        payload: {
                            userId: created.id,
                            email: created.email,
                            firstName: created.first_name,
                            lastName: created.last_name,
                            role: created.role
                        },
                        correlationId: req.correlationId as string
                    });
                    return created;
                });

                await recordAudit({
                    actorId: req.auth!.sub,
                    action: 'user.create',
                    entity: 'users',
                    entityId: user.id,
                    metadata: { role }
                });
                await publishEvent(
                    config,
                    buildEvent(
                        'strafor.user.registered',
                        { userId: user.id, email: user.email, role: user.role, registeredBy: Number(req.auth!.sub) },
                        req.correlationId as string
                    )
                );

                const accessToken = await signAccessToken(user, keys, config);
                const { token: refreshToken } = await issueRefreshToken(
                    user.id,
                    config.refreshTokenTtlDays,
                    clientCtx(req)
                );

                res.status(201).json({
                    ...tokenResponse(accessToken, refreshToken, toPublicUser(user), config.accessTokenTtlSeconds),
                    message: 'User registered successfully'
                });
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'register error');
                res.status(500).json({ error: 'An error occurred during registration' });
            }
        }
    );

    // ---- POST /v1/auth/password/forgot (public, always 200) ----
    router.post('/password/forgot', validate({ body: schema.forgotBody }), async (req: Request, res: Response) => {
        try {
            const { email } = req.body as { email: string };
            const user = await findUserByEmail(email);
            if (user) {
                const token = crypto.randomBytes(32).toString('base64url');
                await query(
                    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
                     VALUES ($1, $2, now() + interval '1 hour')`,
                    [user.id, hashToken(token)]
                );
                const resetLink = `${config.publicBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
                await sendResetNotification(config, user.email, resetLink, req.correlationId as string);
            }
            // Always 200 — never reveal whether the email exists.
            res.json({ message: 'If the account exists, a reset link has been sent' });
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'password forgot error');
            res.json({ message: 'If the account exists, a reset link has been sent' });
        }
    });

    // ---- POST /v1/auth/password/reset (public) ----
    router.post('/password/reset', validate({ body: schema.resetBody }), async (req: Request, res: Response) => {
        try {
            const { token, newPassword } = req.body as { token: string; newPassword: string };
            const { rows } = await query(
                `SELECT * FROM password_reset_tokens
                 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
                [hashToken(token)]
            );
            const row = rows[0] as { id: number; user_id: number } | undefined;
            if (!row) {
                res.status(400).json({ error: 'Invalid or expired reset token' });
                return;
            }
            await updateUser(row.user_id, { password: newPassword, loggedOut: true });
            await query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
            await revokeAllForUser(row.user_id);
            await recordAudit({
                actorId: row.user_id,
                action: 'auth.password_reset',
                entity: 'users',
                entityId: row.user_id
            });
            res.json({ message: 'Password reset successfully' });
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'password reset error');
            res.status(500).json({ error: 'An error occurred during password reset' });
        }
    });

    // ---- POST /v1/auth/password/change (authenticated) ----
    router.post(
        '/password/change',
        verifyServiceToken(deps),
        validate({ body: schema.changePasswordBody }),
        async (req: AuthenticatedRequest, res: Response) => {
            try {
                const { currentPassword, newPassword } = req.body;
                const user = await findUserById(Number(req.auth!.sub));
                if (!user) {
                    res.status(404).json({ error: 'User not found' });
                    return;
                }
                if (!(await comparePassword(currentPassword, user.password))) {
                    res.status(400).json({ error: 'Current password is incorrect' });
                    return;
                }
                await updateUser(user.id, { password: newPassword });
                await revokeAllForUser(user.id);
                // Blacklist the access token that authorized the change.
                const remaining = req.auth!.exp - Math.floor(Date.now() / 1000);
                await blacklistJti(redis, req.auth!.jti, remaining);
                await recordAudit({
                    actorId: user.id,
                    action: 'auth.password_change',
                    entity: 'users',
                    entityId: user.id
                });
                res.json({ message: 'Password changed successfully' });
            } catch (err) {
                logger.error({ err: (err as Error).message }, 'password change error');
                res.status(500).json({ error: 'An error occurred during password change' });
            }
        }
    );

    return router;
}

/** Fire the password-reset email through the notifications service.
 *  The reset link is a bearer credential — it is never logged; only the
 *  masked recipient is recorded. */
async function sendResetNotification(
    config: ServiceConfig,
    email: string,
    resetLink: string,
    correlationId: string
): Promise<void> {
    const masked = email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
    if (!config.notificationsUrl) {
        logger.error({ email: masked }, 'password reset requested but notifications service is not configured');
        return;
    }
    try {
        const resp = await fetch(`${config.notificationsUrl}/v1/notifications/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-correlation-id': correlationId,
                'Idempotency-Key': `pwd-reset-${correlationId}`,
                ...(config.serviceAuthToken ? { 'X-Service-Token': config.serviceAuthToken } : {})
            },
            body: JSON.stringify({
                to: email,
                template: 'auth.password_reset',
                payload: { resetUrl: resetLink },
                locale: 'es'
            }),
            signal: AbortSignal.timeout(5000)
        });
        if (!resp.ok) {
            logger.error({ status: resp.status, email: masked }, 'notifications service rejected reset email');
        }
    } catch (err) {
        logger.error(
            { err: (err as Error).message, email: masked },
            'notifications service unreachable — reset email not delivered'
        );
    }
}
