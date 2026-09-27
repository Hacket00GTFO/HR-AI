import { NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/auth';

// Authenticated BFF proxy. Injects Authorization: Bearer <session-cookie> and
// forwards to the backend. Path mapping:
//   /api/proxy/dashboard/activity → {API_URL}/api/dashboard/activity   (legacy)
//                                 → {GATEWAY_URL}/api/v1/dashboard/activity (v1)
// Query string is preserved. The session cookie itself is never forwarded to
// the backend — Bearer auth only.
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'cookie']);

async function forward(req: NextRequest, path: string[]) {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (!token) {
        return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
    }

    const target = apiUrl(path.join('/')) + req.nextUrl.search;
    const headers = new Headers();
    for (const [key, value] of req.headers.entries()) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
    }
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');

    const init: RequestInit = { method: req.method, headers, cache: 'no-store' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = await req.arrayBuffer();
        const ct = req.headers.get('content-type');
        if (ct) headers.set('Content-Type', ct);
    }

    let upstream: Response;
    try {
        upstream = await fetch(target, init);
    } catch {
        return NextResponse.json({ error: 'Backend unreachable' }, { status: 502 });
    }

    // Binary-safe: the body is piped as raw bytes and the payload headers are
    // forwarded so non-JSON responses (e.g. GET /api/candidates/:id/resume)
    // reach the browser intact. Inline disposition keeps PDFs viewable in a
    // new tab; same-origin <a href> works because the session cookie rides along.
    const body = await upstream.arrayBuffer();
    const resHeaders = new Headers();
    for (const name of ['content-type', 'content-disposition', 'content-length', 'cache-control']) {
        const value = upstream.headers.get(name);
        if (value) resHeaders.set(name, value);
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
