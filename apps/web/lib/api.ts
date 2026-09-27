import { env } from './env';

// Single seam between the frontend and whichever backend is live.
// AUTH_MODE=legacy → the Express monolith ({API_URL}/api/*)
// AUTH_MODE=v1     → the API gateway ({GATEWAY_URL}/api/v1/*)
//
// In v1 the gateway fronts every service, so even the "public" endpoints are
// addressed through it; in legacy mode everything hits the monolith.

export function backendBaseUrl(): string {
    if (env.AUTH_MODE === 'v1') {
        return (env.GATEWAY_URL ?? env.API_URL).replace(/\/$/, '');
    }
    return env.API_URL.replace(/\/$/, '');
}

export function apiPrefix(): string {
    return env.AUTH_MODE === 'v1' ? '/api/v1' : '/api';
}

/** Full backend URL for an API path like 'vacancies' or 'dashboard/activity'. */
export function apiUrl(path: string): string {
    return `${backendBaseUrl()}${apiPrefix()}/${path.replace(/^\//, '')}`;
}

export function authLoginUrl(): string {
    return apiUrl('auth/login');
}

export function authLogoutUrl(): string {
    return apiUrl('auth/logout');
}

/** Server-side fetch with sane defaults for the monolith/gateway. */
export async function backendFetch(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
    const { token, headers, ...rest } = init;
    const merged = new Headers(headers);
    if (!merged.has('Accept')) merged.set('Accept', 'application/json');
    if (token) merged.set('Authorization', `Bearer ${token}`);
    return fetch(apiUrl(path), { cache: 'no-store', ...rest, headers: merged });
}
