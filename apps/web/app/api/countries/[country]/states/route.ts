import { NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';

// Public: GET {API}/api/countries/:country/states → string[] (404 if unknown).
type Ctx = { params: Promise<{ country: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
    const { country } = await ctx.params;
    try {
        const upstream = await fetch(apiUrl(`countries/${encodeURIComponent(country)}/states`), {
            headers: { Accept: 'application/json' },
            next: { revalidate: 86400 }
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
