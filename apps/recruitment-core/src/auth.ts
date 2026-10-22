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
 * HR-only gate — strictly role 'hr'. Admins do NOT inherit HR capabilities:
 * recruitment data (candidate PII) belongs to HR, while admins own platform
 * management. Mirrors the monolith's `isHR` middleware.
 */
export function requireHR(req: Request, _res: Response, next: NextFunction): void {
    const user = parseUserHeaders(req);
    if (!user) {
        throw httpError(401, 'Missing or invalid identity headers');
    }
    if (user.role !== 'hr') {
        throw httpError(403, 'Forbidden');
    }
    req.user = user;
    req.caller = { kind: 'user', user };
    next();
}

/**
 * Accept either a trusted service caller (X-Service-Token ===
 * SERVICE_AUTH_TOKEN) or a gateway user. Callers still needing HR semantics
 * should use `serviceOrHrAuth` — this grants ANY authenticated user.
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
 * Service-token-only guard — for internal write paths other services call
 * (e.g. users_projection upserts). No user identity accepted.
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

/**
 * Accept either a trusted service caller (X-Service-Token) or an HR user.
 * Service callers are trusted platform components; user callers get the same
 * strict 'hr'-only check as requireHR (admin → 403).
 */
export function serviceOrHrAuth(serviceToken: string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const token = req.get('X-Service-Token');
        if (token && tokenMatches(token, serviceToken)) {
            req.caller = { kind: 'service' };
            return next();
        }
        const user = parseUserHeaders(req);
        if (!user) {
            return next(httpError(401, 'Missing or invalid credentials'));
        }
        if (user.role !== 'hr') {
            return next(httpError(403, 'Forbidden'));
        }
        req.user = user;
        req.caller = { kind: 'user', user };
        next();
    };
}
