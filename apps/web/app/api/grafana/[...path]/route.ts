import { NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';
import { SESSION_COOKIE, decodeJwtPayload, type SessionUser } from '@/lib/auth';

// Grafana auth-proxy: validates the session cookie, confirms admin role
// via the monolith, then forwards to Grafana with X-WEBAUTH-USER headers.
// Grafana is never exposed directly — all access goes through this route.

const HOP_BY_HOP = new Set([
    'host',
    'connection',
    'content-length',
    'accept-encoding',
    'cookie',
    'authorization' // we set our own auth-proxy headers
]);

const GRAFANA_URL = process.env.GRAFANA_INTERNAL_URL || 'http://grafana:3000/api/grafana';

async function verifyAdmin(token: string): Promise<SessionUser | null> {
    try {
        const res = await fetch(apiUrl('admin/monitoring/whoami'), {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            cache: 'no-store'
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.role !== 'admin') return null;
        return { email: data.email, role: data.role } as SessionUser;
    } catch {
        return null;
    }
}

async function forward(req: NextRequest, path: string[]) {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (!token) {
        return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
    }

    const user = await verifyAdmin(token);
    if (!user) {
        return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 });
    }

    // Build the Grafana URL: GRAFANA_URL + /path?query
    const grafanaPath = '/' + path.join('/');
    const target = GRAFANA_URL + grafanaPath + req.nextUrl.search;

    // Copy headers, drop hop-by-hop, add auth-proxy headers
    const headers = new Headers();
    for (const [key, value] of req.headers.entries()) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
    }
    headers.set('X-WEBAUTH-USER', user.email || 'admin@strafor.local');
    headers.set(
        'X-WEBAUTH-NAME',
        user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email || 'Admin'
    );

    const init: RequestInit = { method: req.method, headers, cache: 'no-store' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = await req.arrayBuffer();
    }

    let upstream: Response;
    try {
        upstream = await fetch(target, init);
    } catch {
        return NextResponse.json({ error: 'Grafana unreachable' }, { status: 502 });
    }

    // Forward the response — Grafana returns HTML, JSON, JS, CSS, etc.
    const body = await upstream.arrayBuffer();
    const resHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) resHeaders.set(key, value);
    }
    // Rewrite redirect locations to stay inside the BFF route.
    // Grafana (sub-path mode) emits /api/grafana/... locations — already correct
    // for the browser. Bare /... paths get the prefix added.
    const location = resHeaders.get('location');
    if (location && location.startsWith('/') && !location.startsWith('/api/grafana')) {
        resHeaders.set('location', `/api/grafana${location}`);
    }
    return new NextResponse(body, { status: upstream.status, headers: resHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
    return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
    return forward(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
    return forward(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
    return forward(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
    return forward(req, (await ctx.params).path);
}
