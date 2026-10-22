import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { httpError } from '@strafor/node-common';

export interface GatewayUser {
    userId: number;
    role: string;
    /**
     * hr-core employee id. Taken from the X-Employee-Id gateway header;
     * falls back to userId until hr-core wires the user → employee link.
     */
    employeeId: number;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace -- Express Request augmentation
    namespace Express {
        interface Request {
            user?: GatewayUser;
            correlationId?: string;
            log?: import('@strafor/node-common').ServiceLogger;
        }
    }
}

// Roles allowed on self-service endpoints. 'admin' is deliberately absent:
// governance rule — platform admins NEVER see attendance/geo data (403).
const SELF_SERVICE_ROLES = new Set(['hr', 'employee', 'manager']);

// Roles allowed to review corrections and decide leave requests.
const REVIEWER_ROLES = new Set(['hr', 'manager']);

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
    const empRaw = Number(req.get('X-Employee-Id'));
    const employeeId = Number.isInteger(empRaw) && empRaw > 0 ? empRaw : userId;
    return { userId, role, employeeId };
}

/**
 * Self-service guard: any employee-facing role may act on its OWN data.
 * Explicitly rejects 'admin' — platform governance keeps attendance and
 * geolocation data out of admin reach.
 */
export function requireUser(req: Request, _res: Response, next: NextFunction): void {
    const user = parseUserHeaders(req);
    if (!user) {
        throw httpError(401, 'Missing or invalid identity headers');
    }
    if (!SELF_SERVICE_ROLES.has(user.role)) {
        throw httpError(403, 'Forbidden');
    }
    req.user = user;
    next();
}

/** HR-only guard for management endpoints (schedules CRUD, attendance feed). */
export function requireHR(req: Request, _res: Response, next: NextFunction): void {
    const user = parseUserHeaders(req);
    if (!user) {
        throw httpError(401, 'Missing or invalid identity headers');
    }
    if (user.role !== 'hr') {
        throw httpError(403, 'Forbidden');
    }
    req.user = user;
    next();
}

/** Reviewer guard: hr or manager — corrections approval, leave decisions. */
export function requireReviewer(req: Request, _res: Response, next: NextFunction): void {
    const user = parseUserHeaders(req);
    if (!user) {
        throw httpError(401, 'Missing or invalid identity headers');
    }
    if (!REVIEWER_ROLES.has(user.role)) {
        throw httpError(403, 'Forbidden');
    }
    req.user = user;
    next();
}

/**
 * Internal service-to-service guard (X-Service-Token === SERVICE_AUTH_TOKEN).
 * User callers — including admins — get 403; anonymous callers get 401.
 */
export function requireServiceToken(serviceToken: string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const token = req.get('X-Service-Token');
        if (token && tokenMatches(token, serviceToken)) {
            return next();
        }
        if (parseUserHeaders(req)) {
            return next(httpError(403, 'Forbidden'));
        }
        next(httpError(401, 'Missing or invalid service credentials'));
    };
}
