import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, USER_COOKIE, decodeJwtPayload } from '@/lib/auth';

// Client-facing "who am I": the user cookie is httpOnly, so this route is how
// the app shell learns name/role. Falls back to the JWT payload (role, email).
export function GET(req: NextRequest) {
    const session = req.cookies.get(SESSION_COOKIE)?.value;
    if (!session) return NextResponse.json({ message: 'Unauthenticated' }, { status: 401 });

    const raw = req.cookies.get(USER_COOKIE)?.value;
    let user: unknown = null;
    if (raw) {
        try {
            user = JSON.parse(raw);
        } catch {
            user = null;
        }
    }
    if (!user) {
        const payload = decodeJwtPayload(session);
        user = payload ? { id: payload.id, email: payload.email, role: payload.role } : null;
    }
    return NextResponse.json({ user });
}
