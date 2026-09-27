import { NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';

// Public vacancies passthrough — used by the careers page client-side retry
// and by the dashboard for vacancy stats. No auth required upstream.
export async function GET(req: NextRequest) {
    try {
        const upstream = await fetch(apiUrl('vacancies') + req.nextUrl.search, {
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        });
        const body = await upstream.text();
        return new NextResponse(body, {
            status: upstream.status,
            headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }
        });
    } catch {
        return NextResponse.json({ error: 'Backend unreachable' }, { status: 502 });
    }
}
