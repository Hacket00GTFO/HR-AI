import crypto from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { KeySet } from './keys.js';
import type { ServiceConfig } from './config.js';

export interface AccessTokenClaims {
    sub: string;
    email: string;
    role: 'admin' | 'hr';
    location?: unknown;
    jti: string;
    iss: string;
    exp: number;
    iat: number;
}

export interface TokenUser {
    id: number;
    email: string;
    role: string;
    location?: unknown;
}

/** Sign an RS256 access token: {sub, email, role, location, jti, iss}. */
export async function signAccessToken(user: TokenUser, keys: KeySet, config: ServiceConfig): Promise<string> {
    const builder = new SignJWT({
        email: user.email,
        role: user.role,
        ...(user.location !== undefined && user.location !== null ? { location: user.location } : {})
    })
        .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
        .setSubject(String(user.id))
        .setIssuer(config.issuer)
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + config.accessTokenTtlSeconds);
    return builder.sign(keys.privateKey);
}

/** Verify an RS256 access token against the service's own public key. */
export async function verifyAccessToken(token: string, keys: KeySet, issuer: string): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, keys.publicKey, {
        issuer,
        algorithms: ['RS256']
    });
    return payload as unknown as AccessTokenClaims;
}

// ---- MFA challenge tokens ----
// Short-lived, single-purpose JWT issued by POST /v1/auth/login after the
// password check when the user has MFA enabled. It is NOT an access token:
// it carries `purpose: 'mfa_challenge'` + a dedicated audience so it can only
// be redeemed at POST /v1/auth/mfa/verify for real tokens. The jti can be
// blacklisted on use (Redis) to make the challenge single-use.
export const MFA_CHALLENGE_AUDIENCE = 'strafor-mfa-challenge';

export interface MfaChallengeClaims {
    sub: string;
    purpose: 'mfa_challenge';
    jti: string;
    iss: string;
    aud: string;
    exp: number;
    iat: number;
}

export async function signMfaChallengeToken(user: TokenUser, keys: KeySet, config: ServiceConfig): Promise<string> {
    return new SignJWT({ purpose: 'mfa_challenge' })
        .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
        .setSubject(String(user.id))
        .setIssuer(config.issuer)
        .setAudience(MFA_CHALLENGE_AUDIENCE)
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + config.mfaChallengeTtlSeconds)
        .sign(keys.privateKey);
}

/** Verify an MFA challenge token — rejects access tokens and vice versa. */
export async function verifyMfaChallengeToken(
    token: string,
    keys: KeySet,
    issuer: string
): Promise<MfaChallengeClaims> {
    const { payload } = await jwtVerify(token, keys.publicKey, {
        issuer,
        audience: MFA_CHALLENGE_AUDIENCE,
        algorithms: ['RS256']
    });
    if (payload['purpose'] !== 'mfa_challenge') {
        throw new Error('not an mfa challenge token');
    }
    return payload as unknown as MfaChallengeClaims;
}

export function isJwtError(err: unknown): boolean {
    return err instanceof joseErrors.JOSEError || err instanceof Error;
}

/** Opaque refresh token (returned to the client once; stored hashed). */
export function generateRefreshToken(): string {
    return crypto.randomBytes(48).toString('base64url');
}

export function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}
