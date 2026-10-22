// Cross-service authorization matrix — E2E through the gateway and direct to
// service ports. Every cell of docs/security/role-matrix.md is produced here.
//
// Layers:
//   gateway — real RS256 JWTs (admin/hr from identity login), anonymous,
//             forged X-User-* headers without a JWT, and X-Service-Token
//             (which the gateway must strip → 401 on business routes).
//   direct  — service ports with asserted X-User-* headers (simulating the
//             post-gateway trust model; the ONLY way to exercise the
//             employee/manager/candidate roles — identity-auth's users table
//             CHECK constraint admits admin/hr only) and the service token.
import { describe, it, expect, beforeAll } from 'vitest';
import { config, liveGateway, liveService } from './helpers/env.js';
import { GATEWAY_CASES, DIRECT_CASES, check, newCtx, type Case, type Ctx } from './helpers/matrix.js';
import { acquireTokens, linkEmployeeDirectory, SUITE_AUTH_MATRIX } from './helpers/setup.js';
import { resetResults } from './helpers/report.js';
import type { Persona } from './helpers/token.js';

const ctx: Ctx = newCtx();
let gatewayUp = false;
let loginErrors: string[] = [];

function personasOf(c: Case): Persona[] {
    const set = new Set<Persona>([
        ...(Object.keys(c.expect) as Persona[]),
        ...(Object.keys(c.tolerated ?? {}) as Persona[])
    ]);
    return [...set];
}

/** Skip conditions for a single cell; returns reason or null to run. */
async function skipReason(c: Case, persona: Persona): Promise<string | null> {
    if (c.via === 'gateway') {
        if (!gatewayUp) return `gateway unreachable at ${config.baseUrl} (set E2E_BASE_URL / start compose)`;
        if ((persona === 'admin' || persona === 'hr') && !ctx.tokens[persona]) {
            return `no ${persona} token — seed users with \`pnpm seed\` (${loginErrors.join('; ') || 'login failed'})`;
        }
    } else {
        if (!(await liveService(c.serviceBase!))) {
            return `${c.service} unreachable at ${config.services[c.serviceBase!]}`;
        }
    }
    if (persona === 'service' && !config.serviceToken) {
        return 'no service token (E2E_SERVICE_TOKEN / .env SERVICE_AUTH_TOKEN)';
    }
    return null;
}

describe('cross-service role matrix — gateway layer (/api/v1/* via :8081)', () => {
    beforeAll(async () => {
        resetResults(SUITE_AUTH_MATRIX);
        gatewayUp = await liveGateway();
        if (gatewayUp) {
            ({ errors: loginErrors } = await acquireTokens(ctx));
            await linkEmployeeDirectory(ctx);
        } else {
            console.warn(`[e2e] gateway unreachable at ${config.baseUrl} — gateway-layer cells skipped`);
        }
    });

    for (const c of GATEWAY_CASES) {
        describe(c.id, () => {
            for (const persona of personasOf(c)) {
                it(`${c.method} ${c.path} as ${persona}`, async (t) => {
                    const reason = await skipReason(c, persona);
                    if (reason) return t.skip();
                    const { verdict, resp, row } = await check(SUITE_AUTH_MATRIX, ctx, c, persona);
                    if (verdict === 'tolerated') {
                        console.warn(
                            `⚠ known gap: ${row.caseId} as ${persona} → ${resp.status} (${row.note || 'tolerated'})`
                        );
                    }
                    expect(
                        verdict,
                        `${c.id} as ${persona}: got ${resp.status}, expected ${JSON.stringify(row.expected)}` +
                            (row.tolerated.length ? ` (tolerated ${JSON.stringify(row.tolerated)})` : '')
                    ).not.toBe('fail');
                });
            }
        });
    }
});

describe('cross-service role matrix — direct layer (asserted identity / service token)', () => {
    for (const c of DIRECT_CASES) {
        describe(c.id, () => {
            for (const persona of personasOf(c)) {
                it(`${c.method} ${c.path} as ${persona}`, async (t) => {
                    const reason = await skipReason(c, persona);
                    if (reason) return t.skip();
                    const { verdict, resp, row } = await check(SUITE_AUTH_MATRIX, ctx, c, persona);
                    if (verdict === 'tolerated') {
                        console.warn(`⚠ known gap: ${row.caseId} as ${persona} → ${resp.status}`);
                    }
                    expect(
                        verdict,
                        `${c.id} as ${persona}: got ${resp.status}, expected ${JSON.stringify(row.expected)}` +
                            (row.tolerated.length ? ` (tolerated ${JSON.stringify(row.tolerated)})` : '')
                    ).not.toBe('fail');
                });
            }
        });
    }
});
