// Secret hygiene — the M365 tenant id / client id / client secret must
// never appear in logger output or API responses, in either provider mode.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { ServiceLogger } from '@strafor/node-common';
import { SERVICE, testApp, testConfig } from './helpers.js';
import { createM365Provider } from '../src/provider.js';

const TENANT = 'tenant-aaaa-1111-secret';
const CLIENT = 'client-bbbb-2222-secret';
const SECRET = 'client-secret-cccc-3333';

function recordingLog() {
    const entries: string[] = [];
    const mk = () => (obj: unknown, msg?: string) => entries.push(JSON.stringify({ obj, msg }));
    const log: ServiceLogger = {
        trace: mk(),
        debug: mk(),
        info: mk(),
        warn: mk(),
        error: mk(),
        fatal: mk(),
        child: () => log
    };
    return { log, text: () => entries.join('\n') };
}

const m365Config = () => testConfig({ M365_TENANT_ID: TENANT, M365_CLIENT_ID: CLIENT, M365_CLIENT_SECRET: SECRET });

describe('no secrets in logs', () => {
    it('token endpoint failure logs only {status, code}', async () => {
        const { log, text } = recordingLog();
        const impl = vi.fn(async () => ({
            ok: false,
            status: 400,
            json: async () => ({
                error: 'invalid_client',
                // Simulate an IdP error body that echoes request context —
                // it must never reach the logs.
                error_description: `tenant ${TENANT} secret ${SECRET} rejected`
            })
        })) as unknown as typeof fetch;
        const provider = createM365Provider({
            tenantId: TENANT,
            clientId: CLIENT,
            clientSecret: SECRET,
            fetchImpl: impl,
            log
        });
        await expect(
            provider.getFreeBusy(['a@b.c'], new Date('2030-01-01T09:00Z'), new Date('2030-01-01T10:00Z'))
        ).rejects.toMatchObject({ status: 502 });
        expect(text()).not.toContain(TENANT);
        expect(text()).not.toContain(CLIENT);
        expect(text()).not.toContain(SECRET);
    });

    it('network failures and graph failures log nothing sensitive', async () => {
        const { log, text } = recordingLog();
        let call = 0;
        const impl = vi.fn(async () => {
            call += 1;
            if (call === 1) {
                // token fetch OK
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ access_token: 'tok', expires_in: 3600 })
                } as Response;
            }
            throw new Error(`socket to ${TENANT} failed with ${SECRET}`); // hostile error text
        }) as unknown as typeof fetch;
        const provider = createM365Provider({
            tenantId: TENANT,
            clientId: CLIENT,
            clientSecret: SECRET,
            fetchImpl: impl,
            log
        });
        await expect(
            provider.getFreeBusy(['a@b.c'], new Date('2030-01-01T09:00Z'), new Date('2030-01-01T10:00Z'))
        ).rejects.toMatchObject({ status: 502, message: 'Calendar provider unreachable' });
        expect(text()).not.toContain(TENANT);
        expect(text()).not.toContain(SECRET);
    });
});

describe('masked config surface', () => {
    it('GET /v1/calendar/provider masks tenant/client ids and the secret', async () => {
        const { app } = testApp({ config: m365Config() });
        const res = await request(app).get('/v1/calendar/provider').set(SERVICE);
        expect(res.status).toBe(200);
        expect(res.body.provider).toBe('m365');
        expect(res.body.m365.tenantId).toBe('tena…');
        expect(res.body.m365.clientId).toBe('clie…');
        expect(res.body.m365.clientSecret).toBe('********');
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(TENANT);
        expect(body).not.toContain(CLIENT);
        expect(body).not.toContain(SECRET);
    });

    it('/ready reports m365 mode without leaking credential material', async () => {
        const { app } = testApp({ config: m365Config() });
        const res = await request(app).get('/ready');
        expect(res.status).toBe(200);
        expect(res.body.checks.provider).toBe('m365');
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(TENANT);
        expect(body).not.toContain(CLIENT);
        expect(body).not.toContain(SECRET);
    });
});
