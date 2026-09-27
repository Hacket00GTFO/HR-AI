import { NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';
import { MAX_RESUME_BYTES, RESUME_MIME_TYPES, applyBodySchema, applyResponseSchema } from '@/lib/schemas';

// BFF multipart proxy: re-validates fields + resume (type/size) server-side,
// then forwards FormData to POST {API}/api/public/apply. Status codes are
// meaningful to the client: 201 created, 200 duplicate, 4xx validation.
export async function POST(req: NextRequest) {
    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
    }

    const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
    const parsed = applyBodySchema.safeParse(fields);
    if (!parsed.success) {
        return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 });
    }

    const resume = form.get('resume');
    if (resume instanceof File && resume.size > 0) {
        const typeOk =
            (RESUME_MIME_TYPES as readonly string[]).includes(resume.type) || /\.(pdf|docx)$/i.test(resume.name);
        if (resume.size > MAX_RESUME_BYTES) {
            return NextResponse.json({ error: 'Resume exceeds the 5 MB limit' }, { status: 413 });
        }
        if (!typeOk) {
            return NextResponse.json({ error: 'Only PDF or DOCX files are allowed' }, { status: 415 });
        }
    }

    const upstreamForm = new FormData();
    for (const [key, value] of Object.entries(parsed.data)) {
        if (value !== undefined && value !== null) upstreamForm.set(key, String(value));
    }
    if (resume instanceof File && resume.size > 0) {
        upstreamForm.set('resume', resume, resume.name);
    }

    let upstream: Response;
    try {
        upstream = await fetch(apiUrl('public/apply'), {
            method: 'POST',
            body: upstreamForm,
            cache: 'no-store'
        });
    } catch {
        return NextResponse.json({ error: 'Application service unreachable' }, { status: 502 });
    }

    const raw = await upstream.json().catch(() => ({}));
    if (upstream.ok) {
        const body = applyResponseSchema.safeParse(raw);
        if (body.success) return NextResponse.json(body.data, { status: upstream.status });
    }
    return NextResponse.json(raw, { status: upstream.status });
}
