import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import type { KeySet } from '../keys.js';
import { verifyAccessToken, type AccessTokenClaims } from '../tokens.js';
import { isBlacklisted } from '../redis.js';
import { findUserById } from '../users.js';
import type { ServiceConfig } from '../config.js';

export interface AuthenticatedRequest extends Request {
    auth?: AccessTokenClaims & { token: string };
}

export interface AuthDeps {
    keys: KeySet;
    config: ServiceConfig;
    redis: Redis | null;
}

export function bearerToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    return header.slice(7);
}

/**
 * verifyServiceToken — validate an RS256 access token against this service's
 * public key (same key exposed via /.well-known/jwks.json and consumed by the
 * gateway and other services). Also enforces revocation: Redis blacklist
 * (bl:<jti>) when Redis is configured, else the users.logged_out flag.
 */
export function verifyServiceToken(deps: AuthDeps): RequestHandler {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        const token = bearerToken(req);
        if (!token) {
            res.status(401).json({ error: 'No token provided' });
            return;
        }

        let claims: AccessTokenClaims;
        try {
            claims = await verifyAccessToken(token, deps.keys, deps.config.issuer);
        } catch {
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        // Revocation: Redis blacklist first; DB logged_out flag as fallback
        // when Redis is not configured.
        if (claims.jti) {
            if (await isBlacklisted(deps.redis, claims.jti)) {
                res.status(401).json({ error: 'Token has been revoked' });
                return;
            }
        } else if (!deps.redis) {
            try {
                const user = await findUserById(Number(claims.sub));
                if (!user || user.logged_out || user.active === false) {
                    res.status(401).json({ error: 'Token is no longer valid' });
                    return;
                }
            } catch {
                res.status(503).json({ error: 'Authentication service unavailable' });
                return;
            }
        }

        req.auth = { ...claims, token };
        next();
    };
}

export function requireAdmin(deps: AuthDeps): RequestHandler {
    const verify = verifyServiceToken(deps);
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        verify(req, res, () => {
            if (req.auth && req.auth.role === 'admin') {
                next();
            } else {
                res.status(403).json({ error: 'Access denied. Admin privileges required.' });
            }
        });
    };
}

/** Self-or-admin guard for /v1/users/:id. */
export function requireSelfOrAdmin(param = 'id'): RequestHandler {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        const auth = req.auth;
        if (!auth) {
            res.status(401).json({ error: 'No token provided' });
            return;
        }
        const target = Number(req.params[param]);
        if (auth.role === 'admin' || Number(auth.sub) === target) {
            next();
        } else {
            res.status(403).json({ error: 'Access denied' });
        }
    };
}
