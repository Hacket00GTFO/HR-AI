import { NextRequest, NextResponse } from 'next/server';
import { authLogoutUrl } from '@/lib/api';
import { REFRESH_COOKIE, SESSION_COOKIE, USER_COOKIE } from '@/lib/auth';

// BFF logout: best-effort upstream call (legacy marks the user loggedOut so
// the JWT stops working), then clears the session cookies regardless.
export async function POST(req: NextRequest) {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (token) {
        try {
            await fetch(authLogoutUrl(), {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                cache: 'no-store'
            });
        } catch {
            /* upstream unreachable — still clear the local session */
        }
    }
    const res = NextResponse.json({ message: 'Logged out' });
    for (const name of [SESSION_COOKIE, REFRESH_COOKIE, USER_COOKIE]) {
        res.cookies.set(name, '', { path: '/', maxAge: 0 });
    }
    return res;
}
