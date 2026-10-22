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

/** Parse + validate gateway identity headers; null when absent. */
export function parseUserHeaders(req: Request): GatewayUser | null {
    const userId = Number(req.get('X-User-Id'));
    const role = req.get('X-User-Role');
    if (!Number.isInteger(userId) || userId <= 0 || !role) return null;
    return { userId, role };
}

/**
 * Accept either service auth (X-Service-Token === SERVICE_AUTH_TOKEN) or
 * gateway user headers. Used by POST /v1/notifications/send which is called
 * by other services.
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
 * Accept either a trusted service caller (X-Service-Token) or an admin user
 * (gateway identity headers). Used by the admin-facing read/ops endpoints the
 * monolith proxies to — the monolith always sends the service token and, when
 * acting on behalf of a user, forwards X-User-Id/X-User-Role too.
 */
export function serviceOrAdminAuth(serviceToken: string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const token = req.get('X-Service-Token');
        if (token && tokenMatches(token, serviceToken)) {
            req.caller = { kind: 'service' };
            return next();
        }
        const user = parseUserHeaders(req);
        if (user && user.role === 'admin') {
            req.user = user;
            req.caller = { kind: 'user', user };
            return next();
        }
        if (user) {
            return next(httpError(403, 'Forbidden'));
        }
        next(httpError(401, 'Missing or invalid credentials'));
    };
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
    const user = parseUserHeaders(req);
    if (!user) {
        throw httpError(401, 'Missing or invalid identity headers');
    }
    req.user = user;
    next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
    const user = parseUserHeaders(req);
    if (!user) {
        throw httpError(401, 'Missing or invalid identity headers');
    }
    if (user.role !== 'admin') {
        throw httpError(403, 'Forbidden');
    }
    req.user = user;
    next();
}
