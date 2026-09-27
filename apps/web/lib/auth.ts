import { env } from './env';

// Session = httpOnly + sameSite=lax cookie holding the backend token.
// The browser never sees the JWT (unlike the legacy localStorage flow);
// middleware and BFF route handlers are the only readers.
export const SESSION_COOKIE = 'strafor_session';
export const REFRESH_COOKIE = 'strafor_refresh';
// Non-sensitive display info (id/name/role) — readable only server-side too;
// the client gets it via GET /api/auth/me.
export const USER_COOKIE = 'strafor_user';

export const SESSION_MAX_AGE = 60 * 60 * 8; // 8h — backend JWT is 15m; a refresh flow is a gateway concern

export function sessionCookieOptions(maxAge: number = SESSION_MAX_AGE) {
    // secure cookies require HTTPS; allow opting out for HTTP deployments
    // (e.g. localhost dev or HTTP-only Docker setups).
    const cookieSecure = process.env.COOKIE_SECURE ?? (env.NODE_ENV === 'production' ? 'true' : 'false');
    return {
        httpOnly: true,
        sameSite: 'lax' as const,
        secure: cookieSecure === 'true',
        path: '/',
        maxAge
    };
}

export interface SessionUser {
    id?: number | string | undefined;
    firstName?: string | undefined;
    lastName?: string | undefined;
    email?: string | undefined;
    role?: string | undefined;
}

/** Decode a JWT payload without verifying it (display purposes only). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const part = token.split('.')[1];
        if (!part) return null;
        const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json) as Record<string, unknown>;
    } catch {
        return null;
    }
}
