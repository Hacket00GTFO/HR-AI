import { NextRequest, NextResponse } from 'next/server';
import { authLoginUrl } from '@/lib/api';
import { env } from '@/lib/env';
import {
    legacyLoginResponseSchema,
    loginBodySchema,
    mfaChallengeResponseSchema,
    v1LoginResponseSchema
} from '@/lib/schemas';
import { REFRESH_COOKIE, SESSION_COOKIE, USER_COOKIE, sessionCookieOptions } from '@/lib/auth';

// BFF login: proxies credentials to the backend and stores the returned token
// in an httpOnly + sameSite=lax cookie — the browser never touches the JWT.
// AUTH_MODE selects the contract: legacy {token,user} vs v1 {accessToken,refreshToken,user}.
export async function POST(req: NextRequest) {
    const body = loginBodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
        return NextResponse.json({ message: 'Invalid request' }, { status: 400 });
    }

    let upstream: Response;
    try {
        upstream = await fetch(authLoginUrl(), {
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
        // Pass through backend errors (401 invalid credentials, 403 deactivated, 429…)
        return NextResponse.json(raw, { status: upstream.status });
    }

    // MFA challenge (v1 only): password ok but no tokens — the client must
    // complete /api/auth/mfa/verify. Pass through untouched, set NO cookies.
    const challenge = mfaChallengeResponseSchema.safeParse(raw);
    if (challenge.success) {
        return NextResponse.json({ mfa_required: true, challenge_token: challenge.data.challenge_token });
    }

    const parsed =
        env.AUTH_MODE === 'v1' ? v1LoginResponseSchema.safeParse(raw) : legacyLoginResponseSchema.safeParse(raw);
    if (!parsed.success) {
        return NextResponse.json({ message: 'Malformed auth response' }, { status: 502 });
    }

    const data = parsed.data as { accessToken?: string; token?: string; refreshToken?: string; user: unknown };
    const token = env.AUTH_MODE === 'v1' ? data.accessToken : data.token;
    const refreshToken = data.refreshToken;
    const user = data.user;
    if (!token) {
        return NextResponse.json({ message: 'Malformed auth response' }, { status: 502 });
    }

    // Tokens issued without prior enrollment → the client must force the
    // MFA enrollment wizard before the app shell.
    const res = NextResponse.json({
        user,
        message: raw.message ?? 'Login successful',
        mfaSetupRequired: raw.mfa_setup_required === true
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    res.cookies.set(USER_COOKIE, JSON.stringify(user), sessionCookieOptions());
    if (refreshToken) {
        res.cookies.set(REFRESH_COOKIE, refreshToken, sessionCookieOptions(60 * 60 * 24 * 30));
    }
    return res;
}
