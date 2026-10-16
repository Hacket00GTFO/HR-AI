import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { httpError } from '@strafor/node-common';

export interface GatewayUser {
    userId: number;
    role: string;
}

export type Caller = { kind: 'service' } | { kind: 'user'; user: GatewayUser };

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace -- Express Request augmentation
    namespace Express {
        interface Request {
            user?: GatewayUser;
            caller?: Caller;
            correlationId?: string;
            log?: import('@strafor/node-common').ServiceLogger;
        }
    }
}

function tokenMatches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse + validate gateway identity headers; null when absent/invalid. */
export function parseUserHeaders(req: Request): GatewayUser | null {
    const userId = Number(req.get('X-User-Id'));
    const role = req.get('X-User-Role');
    if (!Number.isInteger(userId) || userId <= 0 || !role) return null;
    return { userId, role };
}

/**
 * Accept either a trusted service caller (X-Service-Token ===
 * SERVICE_AUTH_TOKEN) or gateway user headers. Internal callers
 * (recruitment-core, later the employee portal BFF) present the service
 * token.
 */
export function serviceOrUserAuth(serviceToken: string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const token = req.get('X-Service-Token');
        if (token && tokenMatches(token, serviceToken)) {
            req.caller = { kind: 'service' };
            return next();
        }
        const user = parseUserHeaders(req);
        if (user) {
            req.user = user;
            req.caller = { kind: 'user', user };
            return next();
        }
        next(httpError(401, 'Missing or invalid credentials'));
    };
}

/**
 * Require the HR role — strictly role 'hr'. Admins do NOT inherit HR
 * capabilities (governance: platform admins never see employee records or
 * interview scheduling data). Trusted service callers pass through.
 */
export function requireHR(req: Request, _res: Response, next: NextFunction): void {
    if (req.caller?.kind === 'service') return next();
    const user = req.user ?? parseUserHeaders(req);
    if (!user) {
        return next(httpError(401, 'Missing or invalid identity headers'));
    }
    if (user.role !== 'hr') {
        return next(httpError(403, 'Access denied. HR privileges required.'));
    }
    req.user = user;
    next();
}

/**
 * Service-token-only guard — no user identity accepted.
 */
export function requireService(serviceToken: string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const token = req.get('X-Service-Token');
        if (token && tokenMatches(token, serviceToken)) {
            req.caller = { kind: 'service' };
            return next();
        }
        next(httpError(401, 'Missing or invalid service token'));
    };
}

/** Audit-trail actor label for the current caller (never contains secrets). */
export function actorFor(req: Request): string {
    if (req.caller?.kind === 'service') return 'service';
    if (req.user) return `user:${req.user.userId}`;
    return 'anonymous';
}
