import { z } from 'zod';

// Client-side fetch helpers for the BFF routes. Every call goes through
// /api/proxy/* (Bearer injection server-side) or a dedicated route handler —
// the browser never talks to the backend directly and never sees the token.

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        message?: string
    ) {
        super(message ?? `HTTP ${status}`);
        this.name = 'ApiError';
    }
}

const JSON_HEADERS = { Accept: 'application/json' } as const;

/**
 * GET a JSON resource and validate it against a zod schema.
 * Throws ApiError on non-2xx or a payload that doesn't match the schema.
 */
export async function fetchJson<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { ...JSON_HEADERS, ...(init.headers ?? {}) }
    });
    if (!res.ok) throw new ApiError(res.status);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) throw new ApiError(res.status, 'Unexpected response shape');
    return parsed.data;
}

/**
 * JSON mutation helper (POST/PUT/DELETE). Returns the raw Response so callers
 * can map status codes (404 vs 503 vs 400) to messages; parses JSON bodies
 * when present.
 */
export async function sendJson(
    url: string,
    init: { method: 'POST' | 'PUT' | 'DELETE' | 'PATCH'; body?: unknown }
): Promise<{ res: Response; data: unknown }> {
    const res = await fetch(url, {
        method: init.method,
        headers: init.body !== undefined ? { ...JSON_HEADERS, 'Content-Type': 'application/json' } : JSON_HEADERS,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    } as RequestInit);
    const text = await res.text();
    let data: unknown = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }
    }
    return { res, data };
}

/** Extract a human-readable error string from a monolith {error}|{message} envelope. */
export function errorMessage(data: unknown): string | null {
    if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        if (typeof obj.error === 'string' && obj.error) return obj.error;
        if (typeof obj.message === 'string' && obj.message) return obj.message;
    }
    return null;
}
