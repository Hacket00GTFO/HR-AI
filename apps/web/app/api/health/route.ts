import { NextResponse } from 'next/server';

// Container HEALTHCHECK target — always answers, no backend dependency.
export function GET() {
    return NextResponse.json({ status: 'ok', service: 'web', timestamp: new Date().toISOString() });
}
