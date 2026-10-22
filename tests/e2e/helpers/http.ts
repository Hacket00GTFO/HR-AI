// Thin fetch wrapper for the E2E suite — no supertest needed, the suite only
// ever talks to real HTTP endpoints.
export interface Resp {
    status: number;
    body: unknown;
    headers: Headers;
}

export interface ReqOpts {
    method?: string;
    headers?: Record<string, string>;
    /** JSON-serialized when an object; sent verbatim when a string. */
    body?: unknown;
    timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pace requests slightly: hundreds of rapid sequential connections through
// Docker Desktop's port proxy build an accept backlog and new connects stall
// for tens of seconds. ~25ms between calls keeps the suite well under that.
const pace = () => sleep(25);

export async function req(base: string, path: string, opts: ReqOpts = {}): Promise<Resp> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.body !== undefined) {
        if (typeof opts.body === 'string') {
            body = opts.body;
        } else {
            body = JSON.stringify(opts.body);
            headers['Content-Type'] ??= 'application/json';
        }
    }
    const method = opts.method ?? 'GET';
    // Docker Desktop's port forwarding occasionally stalls one connection;
    // idempotent verbs may retry a transport abort (never a wrong status).
    // POST bodies in this suite are validation probes, not creations, so a
    // pre-response abort is safe to retry here too.
    const retryable = true;
    // 429 = the service's rate limiter, not the authorization guard under
    // test. Retry like a real client (Retry-After aware, bounded backoff);
    // if it persists the caller classifies it as 'tolerated'.
    for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
            await pace();
            res = await fetch(`${base}${path}`, {
                method,
                headers,
                ...(body !== undefined ? { body } : {}),
                signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
                redirect: 'manual'
            });
        } catch (err) {
            if (retryable && attempt < 5) {
                await sleep(750);
                continue;
            }
            throw err;
        }
        const text = await res.text();
        let parsed: unknown = text;
        try {
            parsed = JSON.parse(text);
        } catch {
            /* non-JSON body — keep raw text */
        }
        if (res.status !== 429 || attempt >= 5) {
            return { status: res.status, body: parsed, headers: res.headers };
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));
    }
}
