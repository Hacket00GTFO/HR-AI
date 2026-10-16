import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { httpError } from '@strafor/node-common';

/**
 * Authentication & authorization for the documents service.
 *
 * Trust model (privacy audit findings C1 + H1):
 *
 *   - Callers presenting `X-Service-Token === SERVICE_AUTH_TOKEN` are trusted
 *     internal callers (recruitment-core, the monolith, the gateway acting on
 *     behalf of a user). ONLY for these callers are the identity headers
 *     server-verified — including `X-Candidate-Id`, which an internal caller
 *     may use to assert candidate ownership.
 *   - Without a valid service token the request is treated as a browser/user
 *     request: `X-User-Id` + `X-User-Role` (gateway-injected from the JWT) are
 *     required, but `X-Candidate-Id` is client-forgeable — this service cannot
 *     verify candidate identity itself — so the header is IGNORED and the
 *     caller's candidateId stays null. User-auth requests therefore can never
 *     satisfy a document ownership check (fail-closed) until the gateway
 *     forwards a verified candidate identity over a service-token call
 *     (companion gateway change).
 *   - Governance: platform admins must NEVER read business content (resumes,
 *     extracted text). The `admin` role is deliberately excluded from
 *     document access — even when a trusted service caller asserts an admin
 *     identity on a user's behalf.
 *   - `hr` retains full document access (scoped refinement is a follow-up).
 *   - A service caller presenting NO user headers is a pure internal
 *     service-to-service call and is trusted for all documents.
 */

export interface GatewayUser {
    userId: number;
    role: string;
    /** Server-verified candidate profile id — only set for trusted callers. */
    candidateId: number | null;
}

export type Caller =
    /** Trusted internal caller. `user` is the asserted end-user identity, or
     *  null for a pure service-to-service call. */
    | { kind: 'service'; user: GatewayUser | null }
    /** Browser-authenticated user via the gateway. candidateId is always null
     *  — X-Candidate-Id from this path is untrusted and ignored. */
    | { kind: 'user'; user: GatewayUser };

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

/**
 * Roles allowed to access document CONTENT regardless of ownership.
 * `admin` is deliberately absent: platform admins must never read business
 * content (governance rule, audit C1). `hr` keeps staff access for now.
 */
const CONTENT_STAFF_ROLES = new Set(['hr']);

function tokenMatches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse + validate gateway identity headers; null when absent/invalid. */
function parseUserHeaders(req: Request): GatewayUser | null {
    const userId = Number(req.get('X-User-Id'));
    const role = req.get('X-User-Role');
    if (!Number.isInteger(userId) || userId <= 0 || !role) return null;
    return { userId, role, candidateId: null };
}

/** Parse the X-Candidate-Id header; null when absent/invalid. */
function parseCandidateId(req: Request): number | null {
    const raw = req.get('X-Candidate-Id');
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Authenticate every /v1 route. Two accepted credential shapes:
 *
 *   1. X-Service-Token === serviceToken  → trusted internal caller.
 *      X-User-Id/X-User-Role/X-Candidate-Id are honored as server-asserted
 *      identity. X-Candidate-Id without user headers scopes the caller to
 *      that candidate rather than granting full service access.
 *   2. Valid X-User-Id + X-User-Role     → gateway user request.
 *      X-Candidate-Id is untrusted here and ignored (H1).
 *
 * Everything else → 401.
 */
export function requireAuth(serviceToken: string | undefined) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const token = req.get('X-Service-Token');
        if (serviceToken && token && tokenMatches(token, serviceToken)) {
            const user = parseUserHeaders(req);
            const candidateId = parseCandidateId(req);
            if (user) {
                user.candidateId = candidateId;
                req.user = user;
                req.caller = { kind: 'service', user };
            } else if (candidateId !== null) {
                // Trusted caller asserting a candidate context without user
                // headers — scope access to that candidate, don't widen it.
                const scoped: GatewayUser = { userId: 0, role: 'candidate', candidateId };
                req.user = scoped;
                req.caller = { kind: 'service', user: scoped };
            } else {
                req.caller = { kind: 'service', user: null };
            }
            return next();
        }

        const user = parseUserHeaders(req);
        if (!user) {
            return next(httpError(401, 'Missing or invalid credentials'));
        }
        if (req.get('X-Candidate-Id') !== undefined) {
            req.log?.warn('X-Candidate-Id from non-service caller ignored (untrusted, audit H1)');
        }
        // candidateId intentionally stays null — the claim is unverifiable.
        req.user = user;
        req.caller = { kind: 'user', user };
        next();
    };
}

/**
 * Governance guard (audit C1): any asserted `admin` identity is denied before
 * reaching a handler — covers routes like upload where no document row (and
 * thus no per-document ACL check) exists yet. Pure service callers pass.
 */
export function denyAdminContent(req: Request, _res: Response, next: NextFunction): void {
    if (req.user?.role === 'admin') {
        return next(httpError(403, 'Forbidden'));
    }
    next();
}

/**
 * Document-content ACL:
 *   - pure service caller (no asserted user)        → allowed (trusted internal)
 *   - asserted/user role `admin`                    → denied (audit C1)
 *   - role `hr`                                     → allowed (staff)
 *   - otherwise                                     → only when caller's
 *     server-verified candidateId matches documents.owner_candidate_id.
 *     User-auth callers have candidateId=null, so they always fail here.
 */
export function canAccessDocument(caller: Caller, ownerCandidateId: number | null): boolean {
    const user = caller.user;
    if (!user) return caller.kind === 'service';
    if (user.role === 'admin') return false;
    if (CONTENT_STAFF_ROLES.has(user.role)) return true;
    return ownerCandidateId !== null && user.candidateId === ownerCandidateId;
}
