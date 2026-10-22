import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { httpError } from '@strafor/node-common';
import type { Queryable } from './db.js';

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
            /** Resolved hr-core employee id for self-service callers. */
            employeeId?: number;
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
 * SERVICE_AUTH_TOKEN) or gateway user headers. Internal callers (the
 * monolith BFF, other services) present the service token.
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
 * HR-service data). Trusted service callers pass through.
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
 * Employee self-service guard — requires a gateway user identity and
 * resolves the caller's hr-core employee id via the employee_directory
 * projection (fed by /v1/internal/employee-directory upserts).
 *
 *   - no/invalid identity headers           → 401
 *   - role 'admin'                          → 403 (platform admins are barred
 *     from EVERY business route, including self-service employee data)
 *   - service token without user identity   → 401 (a service caller has no
 *     employee context)
 *   - user with no linked employee record   → 403
 *
 * On success `req.employeeId` is set; every self-service query MUST scope on
 * it so a user can never read another employee's data.
 */
export function requireEmployee(db: Queryable) {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
        try {
            const user = req.user ?? parseUserHeaders(req);
            if (!user) {
                return next(httpError(401, 'Missing or invalid identity headers'));
            }
            if (user.role === 'admin') {
                return next(httpError(403, 'Access denied.'));
            }
            req.user = user;
            req.caller = { kind: 'user', user };
            const { rows } = await db.query(`SELECT id FROM employee_directory WHERE user_id = $1`, [user.userId]);
            if (!rows[0]) {
                return next(httpError(403, 'No employee record is linked to this user'));
            }
            req.employeeId = Number(rows[0].id);
            next();
        } catch (err) {
            next(err);
        }
    };
}

/**
 * Service-token-only guard — for internal write paths other services call
 * (employee_directory upserts). No user identity accepted.
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
