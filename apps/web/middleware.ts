import { NextRequest, NextResponse } from 'next/server';

// Keep middleware self-contained (no app imports → no env parsing in the edge
// bundle). The cookie name mirrors SESSION_COOKIE in lib/auth.ts.
const SESSION_COOKIE = 'strafor_session';

// Auth gate for the app shell. Public: /, /login, /careers*, /api/*, statics.
// The cookie is httpOnly — middleware only checks presence; real validation
// happens at the backend on every proxied call.
const PUBLIC_PREFIXES = ['/login', '/careers', '/portal/candidato', '/api/', '/_next', '/favicon'];
const PUBLIC_FILE = /\.[^/]+$/;

export function middleware(req: NextRequest) {
    const { pathname } = req.nextUrl;

    if (pathname === '/' || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) || PUBLIC_FILE.test(pathname)) {
        return NextResponse.next();
    }

    if (!req.cookies.get(SESSION_COOKIE)?.value) {
        const loginUrl = new URL('/login', req.url);
        loginUrl.searchParams.set('next', pathname);
        return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
}

export const config = {
    matcher: ['/((?!_next/static|_next/image).*)']
};
