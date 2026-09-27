import { NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';

// Public: GET {API}/api/countries → string[] of country names.
export async function GET() {
    try {
        const upstream = await fetch(apiUrl('countries'), {
            headers: { Accept: 'application/json' },
            next: { revalidate: 86400 } // reference data — cache a day
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
