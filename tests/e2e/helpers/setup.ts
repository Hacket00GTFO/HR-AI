// Shared live-stack bootstrap for the suites:
//   - probes gateway + service liveness
//   - logs in the seeded admin/hr users and discovers their ids from the JWT
//   - links users → employee ids in hr-services' employee_directory (needed
//     by requireEmployee self-service routes) via the service-token endpoint
import { config, liveGateway, liveService } from './env.js';
import { req } from './http.js';
import { decodeClaims, login, serviceAuth } from './token.js';
import { newCtx, type Ctx } from './matrix.js';

export const SUITE_AUTH_MATRIX = 'auth-matrix';
export const SUITE_PERSONAS = 'personas';
export const SUITE_HEADERS = 'header-stripping';

/** Acquire admin + hr JWTs; failures leave tokens unset (tests skip). */
export async function acquireTokens(ctx: Ctx): Promise<{ admin?: string; hr?: string; errors: string[] }> {
    const errors: string[] = [];
    for (const role of ['admin', 'hr'] as const) {
        try {
            const token = await login(config.baseUrl, config.users[role].email, config.users[role].password);
            ctx.tokens[role] = token;
            const sub = Number(decodeClaims(token).sub);
            if (Number.isInteger(sub) && sub > 0) ctx.userIds[role] = sub;
        } catch (err) {
            errors.push(`${role}: ${(err as Error).message}`);
        }
    }
    return { ...ctx.tokens, errors };
}

/**
 * Upsert employee_directory rows so requireEmployee-guarded routes resolve a
 * caller's employee id. Links the real hr user plus the asserted personas.
 * No-op (returns false) when the service token or hr-services is unavailable.
 */
export async function linkEmployeeDirectory(ctx: Ctx): Promise<boolean> {
    if (!config.serviceToken) return false;
    if (!(await liveService('hrServices'))) return false;
    const res = await req(config.services.hrServices, '/v1/internal/employee-directory', {
        method: 'POST',
        headers: serviceAuth(),
        body: {
            employees: [
                { id: 9001, userId: ctx.userIds.hr, firstName: 'E2E', lastName: 'Hr', department: 'Engineering' },
                { id: 9002, userId: ctx.ids.employeeA, firstName: 'E2E', lastName: 'EmpA', department: 'Engineering' },
                { id: 9003, userId: ctx.ids.employeeB, firstName: 'E2E', lastName: 'EmpB', department: 'Sales' },
                { id: 9004, userId: ctx.ids.manager, firstName: 'E2E', lastName: 'Mgr', department: 'Engineering' }
            ]
        }
    });
    return res.status === 200;
}

export { liveGateway, liveService };
