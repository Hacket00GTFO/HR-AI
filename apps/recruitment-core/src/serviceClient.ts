// Shared outbound HTTP client for service-to-service calls.
// Ported from the monolith's utils/serviceClient.js and extended with the
// documents-resumes multipart helpers this service needs.
// - callService: generic JSON call — throws ServiceError {code:'timeout'|'unavailable'|'http_error'}
// - uploadDocument / fetchDocumentDownload: documents-resumes integration
// - every call forwards X-Service-Token + X-Correlation-Id, and the caller's
//   X-User-Id/X-User-Role when a gateway user initiated the request.
import { randomUUID } from 'node:crypto';
import type { ServiceLogger } from '@strafor/node-common';
import { logger as rootLogger } from '@strafor/node-common';
import type { GatewayUser } from './auth.js';

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
    method?: string | undefined;
    body?: unknown;
    timeout?: number | undefined;
    headers?: Record<string, string> | undefined;
    correlationId?: string | null | undefined;
    serviceToken?: string | null | undefined;
    /** Gateway user context forwarded as X-User-Id / X-User-Role. */
    user?: GatewayUser | null | undefined;
}

function callerHeaders(opts: CallOptions): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Correlation-Id': opts.correlationId || randomUUID()
    };
    if (opts.serviceToken) headers['X-Service-Token'] = opts.serviceToken;
    if (opts.user) {
        headers['X-User-Id'] = String(opts.user.userId);
        headers['X-User-Role'] = opts.user.role;
    }
    return headers;
}

/**
 * callService('http://ai-matching:3005', '/v1/score', { method, body, ... })
 * Returns parsed JSON (or null for empty bodies). Throws ServiceError.
 */
export async function callService(baseUrl: string | undefined, path: string, opts: CallOptions = {}): Promise<unknown> {
    const { method = 'GET', body, timeout = 8000, headers = {} } = opts;
    if (!baseUrl) {
        throw new ServiceError('unavailable', 'service base URL is not configured');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const resp = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
            method,
            headers: {
                ...callerHeaders(opts),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...headers
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal
        });
        if (!resp.ok) {
            // Never embed the upstream body: it can carry PII from
            // identity/documents/AI error responses into our logs.
            await resp.text().catch(() => '');
            throw new ServiceError('http_error', `service responded ${resp.status}`, {
                status: resp.status
            });
        }
        if (resp.status === 204) return null;
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) return resp.json();
        return resp.text();
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

export interface UploadedDocument {
    id: string;
    candidateId?: number | null;
    kind?: string;
    originalName?: string;
    mime?: string;
    sizeBytes?: number;
    sha256?: string;
    s3Key?: string;
    status?: string;
    deduplicated?: boolean;
    [key: string]: unknown;
}

/**
 * Forward a validated resume buffer to documents-resumes
 * (POST /v1/documents, multipart field `file`). Returns the document row
 * (its `id` becomes candidates.resume_document_id).
 */
export async function uploadDocument(
    baseUrl: string | undefined,
    file: { buffer: Buffer; originalname: string; mime: string },
    opts: CallOptions & { candidateId?: number | null | undefined; kind?: string | undefined } = {}
): Promise<UploadedDocument> {
    if (!baseUrl) {
        throw new ServiceError('unavailable', 'documents service base URL is not configured');
    }
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mime }), file.originalname);
    if (opts.candidateId != null) form.append('candidateId', String(opts.candidateId));
    if (opts.kind) form.append('kind', opts.kind);

    const timeout = opts.timeout ?? 20000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/documents`, {
            method: 'POST',
            // No Content-Type — fetch sets the multipart boundary itself.
            headers: { ...callerHeaders(opts), Accept: 'application/json' },
            body: form,
            signal: controller.signal
        });
        if (!resp.ok) {
            await resp.text().catch(() => '');
            throw new ServiceError('http_error', `documents service responded ${resp.status}`, {
                status: resp.status
            });
        }
        return (await resp.json()) as UploadedDocument;
    } catch (err) {
        if (err instanceof ServiceError) throw err;
        if ((err as Error).name === 'AbortError') {
            throw new ServiceError('timeout', `documents upload timed out after ${timeout}ms`, { cause: err });
        }
        throw new ServiceError('unavailable', `documents service unreachable: ${(err as Error).message}`, {
            cause: err
        });
    } finally {
        clearTimeout(timer);
    }
}

export interface DocumentDownload {
    url: string;
    expiresInSeconds: number;
}

/**
 * Resolve a document id to a presigned download URL via documents-resumes
 * (GET /v1/documents/:id/download). Throws ServiceError{status:404} when the
 * document does not exist upstream.
 */
export async function fetchDocumentDownload(
    baseUrl: string | undefined,
    documentId: string,
    opts: CallOptions = {}
): Promise<DocumentDownload> {
    const data = (await callService(baseUrl, `/v1/documents/${documentId}/download`, {
        method: 'GET',
        timeout: opts.timeout ?? 8000,
        correlationId: opts.correlationId,
        serviceToken: opts.serviceToken,
        user: opts.user
    })) as DocumentDownload;
    return data;
}

export { rootLogger as logger, type ServiceLogger };
