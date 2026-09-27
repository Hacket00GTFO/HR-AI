import { cookies } from 'next/headers';
import { SESSION_COOKIE, USER_COOKIE, decodeJwtPayload, type SessionUser } from './auth';

/**
 * Read the current session user in a server component. Mirrors the logic in
 * app/(app)/layout.tsx: prefer the non-sensitive user cookie, fall back to the
 * JWT payload for role information. Middleware guarantees a session exists
 * on authenticated routes, so the result is only null for tampered cookies.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
    const store = await cookies();

    const raw = store.get(USER_COOKIE)?.value;
    if (raw) {
        try {
            return JSON.parse(raw) as SessionUser;
        } catch {
            /* fall through to JWT */
        }
    }

    const token = store.get(SESSION_COOKIE)?.value;
    const payload = token ? decodeJwtPayload(token) : null;
    if (!payload) return null;
    return {
        id: payload.id as string | number | undefined,
        email: payload.email as string | undefined,
        role: payload.role as string | undefined
    };
}
