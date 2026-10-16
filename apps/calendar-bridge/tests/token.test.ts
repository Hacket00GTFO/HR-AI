// Client-credentials token provider — cache/expiry math, inflight
// coalescing, and error handling.
import { describe, it, expect, vi } from 'vitest';
import { createClientCredentialsTokenProvider } from '../src/token.js';

const OPTS = {
    tenantId: 'tenant-xyz',
    clientId: 'client-xyz',
    clientSecret: 'secret-xyz'
};

function fakeTokenFetch(expiresIn = 3600) {
    const calls: Array<{ url: string; body: string }> = [];
    let n = 0;
    const impl = (async (url: unknown, init?: { body?: unknown }) => {
        calls.push({ url: String(url), body: String(init?.body) });
        n += 1;
        return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: `token-${n}`, expires_in: expiresIn })
        } as Response;
    }) as unknown as typeof fetch;
    return { impl, calls, count: () => n };
}

describe('client-credentials token provider', () => {
    it('fetches once and serves subsequent calls from cache', async () => {
        const { impl, count } = fakeTokenFetch();
        const tp = createClientCredentialsTokenProvider({ ...OPTS, fetchImpl: impl, now: () => 1_000 });
        expect(await tp.getToken()).toBe('token-1');
        expect(await tp.getToken()).toBe('token-1');
        expect(count()).toBe(1);
    });

    it('refreshes once the token is within the 60s expiry skew', async () => {
        const { impl, count } = fakeTokenFetch(3600); // expires at t0 + 3_600_000ms
        let clock = 0;
        const tp = createClientCredentialsTokenProvider({ ...OPTS, fetchImpl: impl, now: () => clock });

        clock = 1_000;
        expect(await tp.getToken()).toBe('token-1');
        expect(count()).toBe(1);

        // expiresAt = 1_000 + 3_600_000 = 3_601_000; valid while now < 3_541_000.
        clock = 3_540_999;
        expect(await tp.getToken()).toBe('token-1');
        expect(count()).toBe(1);

        clock = 3_541_000; // exactly at the skew boundary → refresh
        expect(await tp.getToken()).toBe('token-2');
        expect(count()).toBe(2);
    });

    it('coalesces concurrent refreshes into a single token request', async () => {
        const { impl, count } = fakeTokenFetch();
        const tp = createClientCredentialsTokenProvider({ ...OPTS, fetchImpl: impl, now: () => 0 });
        const [a, b, c] = await Promise.all([tp.getToken(), tp.getToken(), tp.getToken()]);
        expect(a).toBe('token-1');
        expect(b).toBe('token-1');
        expect(c).toBe('token-1');
        expect(count()).toBe(1);
    });

    it('sends the client-credentials form to the tenant token endpoint', async () => {
        const { impl, calls } = fakeTokenFetch();
        const tp = createClientCredentialsTokenProvider({ ...OPTS, fetchImpl: impl, now: () => 0 });
        await tp.getToken();
        expect(calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-xyz/oauth2/v2.0/token');
        expect(calls[0]!.body).toContain('grant_type=client_credentials');
        expect(calls[0]!.body).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2F.default');
    });

    it('maps token endpoint rejections to a generic 502 and does not cache', async () => {
        let n = 0;
        const impl = vi.fn(async () => {
            n += 1;
            return {
                ok: false,
                status: 400,
                json: async () => ({ error: 'invalid_client', error_description: 'echoed details' })
            } as Response;
        }) as unknown as typeof fetch;
        const tp = createClientCredentialsTokenProvider({ ...OPTS, fetchImpl: impl, now: () => 0 });
        await expect(tp.getToken()).rejects.toMatchObject({ status: 502 });
        await expect(tp.getToken()).rejects.toMatchObject({ status: 502 });
        expect(n).toBe(2); // failures are never cached
    });

    it('maps network failures to a generic 502', async () => {
        const impl = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;
        const tp = createClientCredentialsTokenProvider({ ...OPTS, fetchImpl: impl, now: () => 0 });
        await expect(tp.getToken()).rejects.toMatchObject({ status: 502 });
    });
});
