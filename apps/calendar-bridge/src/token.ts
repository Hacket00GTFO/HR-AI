import { httpError, type ServiceLogger } from '@strafor/node-common';

/**
 * Entra ID (Azure AD) client-credentials token provider — the MSAL flow
 * implemented with plain fetch (no @azure/msal dependency).
 *
 *   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   grant_type=client_credentials
 *   scope=https://graph.microsoft.com/.default
 *
 * Tokens are cached in-process and refreshed once they are within
 * `SKEW_MS` of expiry, so a token is never used right up to its deadline.
 *
 * SECURITY: the client secret, tenant id and token endpoint URL are never
 * logged. Token endpoint error responses are reduced to a status code +
 * OAuth `error` code — the raw body (error_description can echo request
 * context) is discarded.
 */

export interface TokenProvider {
    /** Returns a valid bearer token, fetching/refreshing as needed. */
    getToken(): Promise<string>;
}

export interface TokenProviderOptions {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    /** Defaults to the Graph .default scope. */
    scope?: string;
    /** Injectable for tests. */
    fetchImpl?: typeof fetch;
    /** Injectable clock (ms epoch) for tests. */
    now?: () => number;
    /** Refresh lead time before nominal expiry. Default 60s. */
    skewMs?: number;
    log?: ServiceLogger;
}

export const DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
export const DEFAULT_SKEW_MS = 60_000;

interface CachedToken {
    accessToken: string;
    /** ms epoch at which the token nominally expires. */
    expiresAt: number;
}

export function createClientCredentialsTokenProvider(opts: TokenProviderOptions): TokenProvider {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const now = opts.now ?? (() => Date.now());
    const skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
    const scope = opts.scope ?? DEFAULT_SCOPE;
    const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(opts.tenantId)}/oauth2/v2.0/token`;

    let cached: CachedToken | null = null;
    let inflight: Promise<string> | null = null;

    async function fetchToken(): Promise<string> {
        // The secret lives only inside this form body — it is never
        // stringified into logs or error messages.
        const form = new URLSearchParams({
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            scope,
            grant_type: 'client_credentials'
        });
        let res: Response;
        try {
            res = await fetchImpl(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: form.toString()
            });
        } catch {
            // Network-level failure — deliberately message-only.
            throw httpError(502, 'Token endpoint unreachable');
        }
        if (!res.ok) {
            // Read the body only to extract the OAuth `error` code; the
            // description is discarded (it may reflect request details).
            let code = 'unknown';
            try {
                const body = (await res.json()) as { error?: unknown };
                if (typeof body.error === 'string') code = body.error;
            } catch {
                /* non-JSON error body — keep 'unknown' */
            }
            opts.log?.warn({ status: res.status, code }, 'm365 token request failed');
            throw httpError(502, 'Token request rejected by identity provider');
        }
        const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
        if (typeof body.access_token !== 'string' || !body.access_token) {
            throw httpError(502, 'Token endpoint returned no access_token');
        }
        const expiresInSec = typeof body.expires_in === 'number' ? body.expires_in : 3600;
        cached = { accessToken: body.access_token, expiresAt: now() + expiresInSec * 1000 };
        return cached.accessToken;
    }

    return {
        getToken(): Promise<string> {
            // Serve from cache until within `skewMs` of expiry.
            if (cached && now() < cached.expiresAt - skewMs) {
                return Promise.resolve(cached.accessToken);
            }
            // Coalesce concurrent refreshes into a single token request.
            if (!inflight) {
                inflight = fetchToken().finally(() => {
                    inflight = null;
                });
            }
            return inflight;
        }
    };
}
