import { NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';
import { env } from '@/lib/env';
import { mfaVerifyBodySchema, v1LoginResponseSchema } from '@/lib/schemas';
import { REFRESH_COOKIE, SESSION_COOKIE, USER_COOKIE, sessionCookieOptions } from '@/lib/auth';

// BFF MFA challenge exchange: forwards {challenge_token, totp_code|recovery_code}
// to the backend and, on success, stores the returned tokens in the same
// httpOnly cookies the login route uses. v1 only — legacy mode has no MFA.
export async function POST(req: NextRequest) {
    if (env.AUTH_MODE !== 'v1') {
        return NextResponse.json({ message: 'MFA not supported in legacy auth mode' }, { status: 404 });
    }

    const body = mfaVerifyBodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
        return NextResponse.json({ message: 'Invalid request' }, { status: 400 });
    }

    let upstream: Response;
    try {
        upstream = await fetch(apiUrl('auth/mfa/verify'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body.data),
            cache: 'no-store'
        });
    } catch {
        return NextResponse.json({ message: 'Authentication service unreachable' }, { status: 502 });
    }

    const raw = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
        return NextResponse.json(raw, { status: upstream.status });
    }

    const parsed = v1LoginResponseSchema.safeParse(raw);
    if (!parsed.success) {
        return NextResponse.json({ message: 'Malformed auth response' }, { status: 502 });
    }

    const res = NextResponse.json({ user: parsed.data.user, message: raw.message ?? 'Login successful' });
    res.cookies.set(SESSION_COOKIE, parsed.data.accessToken, sessionCookieOptions());
    res.cookies.set(USER_COOKIE, JSON.stringify(parsed.data.user), sessionCookieOptions());
    if (parsed.data.refreshToken) {
        res.cookies.set(REFRESH_COOKIE, parsed.data.refreshToken, sessionCookieOptions(60 * 60 * 24 * 30));
    }
    return res;
}
