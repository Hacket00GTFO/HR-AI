import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import jwksClient, { type JwksClient, type SigningKey } from 'jwks-rsa';
import type { Redis } from 'ioredis';
import { logger } from '@strafor/node-common';
import type { GatewayConfig } from './config.js';
import { isPublicV1Path } from './routes.js';
import { isBlacklisted } from './redis.js';

export interface VerifiedClaims {
    sub: string;
    email?: string;
    role?: string;
    location?: unknown;
    jti?: string;
}

/** Headers the gateway injects downstream after verifying the token. */
export const USER_ID_HEADER = 'x-user-id';
export const USER_ROLE_HEADER = 'x-user-role';
export const USER_LOCATION_HEADER = 'x-user-location';
/** Candidate identity must come from the application row — never the client. */
export const CANDIDATE_ID_HEADER = 'x-candidate-id';
/** Service-to-service token — injected by platform services only, never clients. */
export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * Inbound spoofing guard — clients must never set these themselves.
 * Includes X-Candidate-Id (privacy finding H1: a client-supplied candidate id
 * must never be trusted by downstream services) and X-Service-Token (clients
 * could otherwise impersonate a trusted internal caller).
 */
export function stripInboundUserHeaders(req: Request): void {
    delete req.headers[USER_ID_HEADER];
    delete req.headers[USER_ROLE_HEADER];
    delete req.headers[USER_LOCATION_HEADER];
    delete req.headers[CANDIDATE_ID_HEADER];
    delete req.headers[SERVICE_TOKEN_HEADER];
}

export interface AuthDeps {
    config: GatewayConfig;
    redis: Redis | null;
    jwks?: JwksClient; // injectable for tests
}

export function createJwksClient(jwksUri: string): JwksClient {
    return jwksClient({
        jwksUri,
        cache: true,
        cacheMaxAge: 10 * 60 * 1000,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        timeout: 5000
    });
}

function getSigningKey(client: JwksClient, kid: string): Promise<SigningKey> {
    return new Promise((resolve, reject) => {
        client.getSigningKey(kid, (err, key) => {
            if (err) reject(err);
            else resolve(key as SigningKey);
        });
    });
}

/**
 * JWT enforcement for /api/v1/**.
 * - allowlisted paths pass through anonymously
 * - RS256 signature verified against IDENTITY_JWKS_URL (jwks-rsa, cached)
 * - Redis blacklist bl:<jti> checked when REDIS_URL is configured
 * - verified claims forwarded upstream as X-User-Id / X-User-Role /
 *   X-User-Location headers (set on the proxy request, see proxy.ts)
 */
export function v1AuthGuard(deps: AuthDeps): RequestHandler {
    const jwks = deps.jwks ?? createJwksClient(deps.config.identityJwksUrl);

    return async (req: Request & { claims?: VerifiedClaims }, res: Response, next: NextFunction) => {
        const sub = req.path.replace(/^\//, ''); // mounted on /api/v1
        stripInboundUserHeaders(req);
        if (isPublicV1Path(sub, req.method)) return next();

        const header = req.headers.authorization;
        const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) {
            res.status(401).json({ error: 'No token provided' });
            return;
        }

        const decoded = jwt.decode(token, { complete: true });
        const kid = decoded?.header?.kid;
        if (!kid || decoded?.header?.alg !== 'RS256') {
            // Legacy HS256 / malformed tokens are not accepted on /api/v1.
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        let publicKey: string;
        try {
            const key = await getSigningKey(jwks, kid);
            publicKey = key.getPublicKey();
        } catch (err) {
            const name = (err as Error).name || '';
            if (name === 'SigningKeyNotFoundError') {
                res.status(401).json({ error: 'Invalid token' });
            } else {
                logger.error({ err: (err as Error).message }, 'jwks fetch failed');
                res.status(503).json({ error: 'Authentication service unavailable' });
            }
            return;
        }

        let claims: JwtPayload;
        try {
            claims = jwt.verify(token, publicKey, {
                algorithms: ['RS256'],
                issuer: deps.config.issuer
            }) as JwtPayload;
        } catch {
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        if (await isBlacklisted(deps.redis, claims.jti)) {
            res.status(401).json({ error: 'Token has been revoked' });
            return;
        }

        req.claims = {
            sub: String(claims.sub ?? ''),
            ...(claims['email'] !== undefined ? { email: claims['email'] as string } : {}),
            ...(claims['role'] !== undefined ? { role: claims['role'] as string } : {}),
            ...(claims['location'] !== undefined ? { location: claims['location'] } : {}),
            ...(claims.jti !== undefined ? { jti: claims.jti } : {})
        };
        next();
    };
}
