// Minimal outbound service-to-service HTTP client.
// - always sends X-Service-Token + a fresh X-Correlation-Id
// - throws ServiceError {code:'timeout'|'unavailable'|'http_error'}
// - NEVER embeds upstream response bodies in errors (they can carry PII).
import { randomUUID } from 'node:crypto';

export class ServiceError extends Error {
    code: 'timeout' | 'unavailable' | 'http_error';
    status: number | null;
    override cause: unknown;

    constructor(
        code: 'timeout' | 'unavailable' | 'http_error',
        message: string,
        { status = null, cause = null }: { status?: number | null; cause?: unknown } = {}
    ) {
        super(message);
        this.name = 'ServiceError';
        this.code = code;
        this.status = status;
        this.cause = cause;
    }
}

export interface CallOptions {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    token: string;
    timeout?: number;
    correlationId?: string;
}

export interface ServiceResponse {
    status: number;
    data: unknown;
}

/** Errors worth retrying: timeouts, unreachable hosts, 5xx and 429. */
export function isRetryable(err: unknown): boolean {
    if (!(err instanceof ServiceError)) return true; // pg errors, bugs — retry
    if (err.code !== 'http_error') return true;
    return err.status === 429 || (err.status != null && err.status >= 500);
}

export async function callService(
    baseUrl: string,
    path: string,
    opts: CallOptions,
    fetchImpl: typeof fetch = fetch
): Promise<ServiceResponse> {
    const { method = 'GET', body, token, timeout = 10_000 } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const resp = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
            method,
            headers: {
                Accept: 'application/json',
                'X-Service-Token': token,
                'X-Correlation-Id': opts.correlationId || randomUUID(),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal
        });
        if (!resp.ok) {
            // Drain without reading into the error — upstream bodies can
            // carry PII from identity/hr error payloads.
            await resp.text().catch(() => '');
            throw new ServiceError('http_error', `service responded ${resp.status}`, {
                status: resp.status
            });
        }
        if (resp.status === 204) return { status: resp.status, data: null };
        const contentType = resp.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await resp.json() : await resp.text();
        return { status: resp.status, data };
    } catch (err) {
        if (err instanceof ServiceError) throw err;
        if ((err as Error).name === 'AbortError') {
            throw new ServiceError('timeout', `service call timed out after ${timeout}ms`, { cause: err });
        }
        throw new ServiceError('unavailable', `service unreachable: ${(err as Error).message}`, { cause: err });
    } finally {
        clearTimeout(timer);
    }
}
