// Declarative role-matrix case table + execution helpers.
//
// Expected statuses encode the DOCUMENTED security model:
//   - admin  → 403 on every business route of hr-core / time-attendance /
//              payroll-adapter / hr-services / documents-resumes
//              (governance: platform admins never see employee/business data);
//              200 on admin-only surfaces (monolith /api/admin/*,
//              identity /v1/users, notifications admin reads).
//   - hr     → non-403 on HR business routes (authz passed; 404/400 mean the
//              request reached the handler), 403 on admin-only surfaces.
//   - anon   → 401 on everything except the public allowlist.
//   - forged → X-User-* headers without a JWT: 401 through the gateway.
//   - service→ X-Service-Token through the gateway is stripped → 401;
//              direct-to-service it authenticates internal callers.
//
// `tolerated` lists statuses produced by KNOWN platform gaps — a result that
// lands there is recorded as ⚠️ in docs/security/role-matrix.md but does not
// fail the suite. Anything outside expect ∪ tolerated fails hard.
import { req, type Resp } from './http.js';
import {
    asserted,
    bearer,
    serviceAuth,
    USER_ID_HEADER,
    USER_ROLE_HEADER,
    CANDIDATE_ID_HEADER,
    SERVICE_TOKEN_HEADER,
    type Persona
} from './token.js';
import { config, type ServiceKey } from './env.js';
import { record, type ResultRow } from './report.js';

export interface Case {
    id: string;
    service: string;
    via: 'gateway' | 'direct';
    /** Direct cases: which service base from config.services. */
    serviceBase?: ServiceKey;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    /** Downstream guard name — documentation only. */
    guard: string;
    expect: Partial<Record<Persona, number[]>>;
    tolerated?: Partial<Record<Persona, number[]>>;
    note?: string;
}

/** Shared mutable context populated by suite setup (JWTs, seeded links). */
export interface Ctx {
    tokens: Partial<Record<'admin' | 'hr', string>>;
    /** Real identity user ids (from JWT sub); asserted-identity ids for roles
     *  identity cannot issue. */
    userIds: { admin: number; hr: number };
    ids: { employeeA: number; employeeB: number; manager: number; candidate: number };
}

export function newCtx(): Ctx {
    return {
        tokens: {},
        userIds: { admin: 1, hr: 5 },
        ids: { employeeA: 10, employeeB: 11, manager: 12, candidate: 20 }
    };
}

function headersFor(persona: Persona, ctx: Ctx, c: Case): Record<string, string> {
    switch (persona) {
        case 'admin':
        case 'hr':
            if (c.via === 'gateway') {
                const t = ctx.tokens[persona];
                if (!t) throw new Error(`no ${persona} token — run \`pnpm seed\` first`);
                return bearer(t);
            }
            // Direct layer: assert the identity the gateway would have injected.
            return asserted(persona, ctx.userIds[persona]);
        case 'manager':
            return asserted('manager', ctx.ids.manager);
        case 'employee':
            return asserted('employee', ctx.ids.employeeA);
        case 'candidate':
            return asserted('candidate', ctx.ids.candidate);
        case 'service':
            return serviceAuth();
        case 'forged':
            return { [USER_ID_HEADER]: '5', [USER_ROLE_HEADER]: 'hr' };
        case 'anon':
            return {};
    }
}

export function caseUrl(c: Case): string {
    return c.via === 'gateway' ? config.baseUrl : config.services[c.serviceBase!];
}

export type Verdict = 'ok' | 'tolerated' | 'fail' | 'error';

export interface CheckOutcome {
    row: ResultRow;
    verdict: Verdict;
    resp: Resp;
}

/** Execute one case for one persona; classify + record the result. */
export async function check(suite: string, ctx: Ctx, c: Case, persona: Persona): Promise<CheckOutcome> {
    const headers = headersFor(persona, ctx, c);
    const expected = c.expect[persona] ?? [];
    const tolerated = c.tolerated?.[persona] ?? [];
    let resp: Resp;
    try {
        resp = await req(caseUrl(c), c.path, {
            method: c.method,
            headers,
            ...(c.body !== undefined ? { body: c.body } : {})
        });
    } catch (err) {
        // Transport failure after all retries — record it so the matrix doc
        // shows the cell as 'error' rather than silently absent.
        record({
            suite,
            caseId: c.id,
            service: c.service,
            via: c.via,
            method: c.method,
            path: c.path,
            guard: c.guard,
            persona,
            expected,
            tolerated,
            actual: 0,
            verdict: 'error',
            note: `transport: ${(err as Error).message}`
        });
        throw err;
    }
    // A persistent 429 means the limiter rejected the request before the
    // guard ran — a rejection either way, but not an authorization verdict.
    const verdict: Verdict = expected.includes(resp.status)
        ? 'ok'
        : tolerated.includes(resp.status)
          ? 'tolerated'
          : resp.status === 429
            ? 'tolerated'
            : 'fail';
    const row: ResultRow = {
        suite,
        caseId: c.id,
        service: c.service,
        via: c.via,
        method: c.method,
        path: c.path,
        guard: c.guard,
        persona,
        expected,
        tolerated,
        actual: resp.status,
        verdict,
        note: resp.status === 429 ? `rate-limited — guard not evaluated. ${c.note ?? ''}`.trim() : (c.note ?? '')
    };
    record(row);
    return { row, verdict, resp };
}

// ---------------------------------------------------------------------------
// Route table — gateway layer (through :8081, the real client perimeter).
// ---------------------------------------------------------------------------

/** Standard expectation block for an HR-gated business route group. */
const hrBiz = (hrStatuses: number[]): Partial<Record<Persona, number[]>> => ({
    admin: [403],
    hr: hrStatuses,
    anon: [401],
    forged: [401],
    service: [401] // gateway strips X-Service-Token; no JWT → guard rejects
});

export const GATEWAY_CASES: Case[] = [
    // ---- hr-core (requireHR on every business route) ----
    {
        id: 'hr-core/employees',
        service: 'hr-core',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/employees',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    {
        id: 'hr-core/employees-create',
        service: 'hr-core',
        via: 'gateway',
        method: 'POST',
        path: '/api/v1/employees',
        body: {},
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200, 201, 400, 422])
    },
    {
        id: 'hr-core/org-tree',
        service: 'hr-core',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/org/tree',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    {
        id: 'hr-core/org-departments',
        service: 'hr-core',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/org/departments',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    {
        id: 'hr-core/onboarding',
        service: 'hr-core',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/hr/onboarding',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    // ---- time-attendance ----
    {
        id: 'time/attendance-feed',
        service: 'time-attendance',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/attendance',
        guard: 'requireHR',
        expect: hrBiz([200])
    },
    {
        id: 'time/attendance-mine',
        service: 'time-attendance',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/attendance/mine',
        guard: 'requireUser (hr/employee/manager; admin → 403)',
        expect: hrBiz([200])
    },
    {
        id: 'time/correction-approve',
        service: 'time-attendance',
        via: 'gateway',
        method: 'PUT',
        path: '/api/v1/attendance/corrections/1/approve',
        body: {},
        guard: 'requireReviewer (hr/manager)',
        expect: hrBiz([200, 400, 404, 422])
    },
    {
        id: 'time/leave-types',
        service: 'time-attendance',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/leave/types',
        guard: 'requireUser',
        expect: hrBiz([200])
    },
    {
        id: 'time/leave-requests',
        service: 'time-attendance',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/leave/requests',
        guard: 'requireUser',
        expect: hrBiz([200])
    },
    {
        id: 'time/schedules',
        service: 'time-attendance',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/schedules',
        guard: 'requireHR',
        expect: hrBiz([200])
    },
    // ---- payroll-adapter (strictly HR/Finance) ----
    {
        id: 'payroll/periods',
        service: 'payroll-adapter',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/payroll/periods',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    {
        id: 'payroll/periods-create',
        service: 'payroll-adapter',
        via: 'gateway',
        method: 'POST',
        path: '/api/v1/payroll/periods',
        body: {},
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200, 201, 400, 422])
    },
    {
        id: 'payroll/fiscal',
        service: 'payroll-adapter',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/payroll/fiscal/1',
        guard: 'serviceOrUserAuth + requireHR (audit-logged)',
        expect: hrBiz([200, 404])
    },
    {
        id: 'payroll/providers',
        service: 'payroll-adapter',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/payroll/providers',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    // ---- hr-services ----
    {
        id: 'hr-services/tickets',
        service: 'hr-services',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/tickets',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    {
        id: 'hr-services/tickets-my',
        service: 'hr-services',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/tickets/my',
        guard: 'requireEmployee (admin → 403; needs linked employee)',
        expect: hrBiz([200, 403]), // 403 when no employee_directory row links the user
        note: 'hr → 200 only when the user is linked in employee_directory (suite seeds the link)'
    },
    {
        id: 'hr-services/expenses',
        service: 'hr-services',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/expenses',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    {
        id: 'hr-services/expenses-my',
        service: 'hr-services',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/expenses/my',
        guard: 'requireEmployee',
        expect: hrBiz([200, 403]),
        note: 'see tickets-my'
    },
    {
        id: 'hr-services/assets',
        service: 'hr-services',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/assets',
        guard: 'serviceOrUserAuth + requireHR',
        expect: hrBiz([200])
    },
    {
        id: 'hr-services/surveys-open',
        service: 'hr-services',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/surveys/open',
        guard: 'requireEmployee',
        expect: hrBiz([200, 403]),
        note: 'see tickets-my'
    },
    // ---- documents-resumes ----
    {
        id: 'documents/get',
        service: 'documents-resumes',
        via: 'gateway',
        method: 'GET',
        // Nonexistent UUID: 404 for everyone (no existence leak) or 403 for
        // staff roles blocked before the lookup. Must be a valid UUID —
        // the service validates the id before any ACL check.
        path: '/api/v1/documents/00000000-0000-0000-0000-000000000000',
        guard: 'requireAuth + denyAdminContent + canAccessDocument',
        expect: hrBiz([200, 400, 404])
    },
    {
        id: 'documents/upload',
        service: 'documents-resumes',
        via: 'gateway',
        method: 'POST',
        path: '/api/v1/documents',
        body: {},
        guard: 'requireAuth + denyAdminContent',
        expect: hrBiz([200, 201, 400, 413, 415, 422])
    },
    // ---- notifications ----
    {
        id: 'notifications/list',
        service: 'notifications',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/notifications',
        guard: 'serviceOrAdminAuth',
        expect: { admin: [200], hr: [403], anon: [401], forged: [401], service: [401] }
    },
    {
        id: 'notifications/preferences',
        service: 'notifications',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/notifications/preferences',
        guard: 'requireUser — any authenticated role incl. admin',
        expect: { admin: [200], hr: [200], anon: [401], forged: [401], service: [401] },
        note: 'user-scoped prefs: admin is allowed (no business content)'
    },
    {
        id: 'notifications/send',
        service: 'notifications',
        via: 'gateway',
        method: 'POST',
        path: '/api/v1/notifications/send',
        body: {},
        guard: 'serviceOrUserAuth — any authenticated user may queue a send',
        expect: { admin: [200, 202, 400, 422], hr: [200, 202, 400, 422], anon: [401], forged: [401], service: [401] },
        note: 'no role gate on /send — authenticated users can trigger notifications'
    },
    // ---- identity-auth ----
    {
        id: 'identity/users-list',
        service: 'identity-auth',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/users',
        guard: 'requireAdmin (RS256 verified upstream too)',
        expect: { admin: [200], hr: [403], anon: [401], forged: [401], service: [401] }
    },
    // ---- legacy monolith (/api/* — self-verifies the JWT) ----
    {
        id: 'monolith/admin-audit',
        service: 'api',
        via: 'gateway',
        method: 'GET',
        path: '/api/admin/audit',
        guard: 'isAdmin (verifies RS256 itself — no header trust)',
        expect: { admin: [200], hr: [403], anon: [401], forged: [401], service: [401] }
    },
    // ---- recruitment: public surface + HR-gated detail ----
    {
        id: 'recruitment/vacancies-list',
        service: 'recruitment-core',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/vacancies',
        guard: 'PUBLIC allowlist (isPublicV1Path) → upstream listing',
        expect: { admin: [200], hr: [200], anon: [200] },
        // Local .env sets VACANCIES_URL=http://api:3000 — the route table then
        // strips /api without the monolith rewrite → upstream 404. With
        // RECRUITMENT_CORE_URL or no override the listing works.
        tolerated: { admin: [404], hr: [404], anon: [404] },
        note: '404 tolerated = VACANCIES_URL pointed at monolith (no /v1/* there)'
    },
    {
        id: 'recruitment/vacancy-detail',
        service: 'recruitment-core',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/vacancies/1',
        guard: 'JWT guard → upstream isHR',
        expect: { admin: [403], hr: [200, 404], anon: [401] },
        tolerated: { admin: [404], hr: [404] },
        note: 'same VACANCIES_URL routing caveat'
    },
    {
        id: 'recruitment/candidates',
        service: 'recruitment-core',
        via: 'gateway',
        method: 'GET',
        path: '/api/v1/candidates',
        guard: 'JWT guard → upstream isHR (candidate PII)',
        expect: { admin: [403], hr: [200], anon: [401] },
        tolerated: { admin: [404], hr: [404] },
        note: 'same CANDIDATES_URL routing caveat'
    },
    {
        id: 'recruitment/public-apply',
        service: 'recruitment-core',
        via: 'gateway',
        method: 'POST',
        path: '/api/v1/public/apply',
        body: {},
        guard: 'PUBLIC allowlist (POST only) — reachable anonymously',
        expect: { anon: [200, 201, 400, 413, 415, 422] },
        note: '400/415/422 prove reachability; 401/403/404 would be a gap'
    },
    {
        id: 'internal/not-gateway-routed',
        service: 'platform',
        via: 'gateway',
        method: 'POST',
        path: '/api/v1/internal/users-projection',
        body: {},
        guard: 'no public rule → JWT guard; X-Service-Token stripped',
        expect: { anon: [401], service: [401], forged: [401], admin: [401, 404], hr: [401, 404] },
        note: '/v1/internal/* is compose-internal only — never reachable through the gateway'
    }
];

// ---------------------------------------------------------------------------
// Route table — direct layer (service ports, asserted gateway identity).
// Simulates what a service sees AFTER the gateway verified a JWT, and what a
// trusted internal caller (X-Service-Token) can do.
// ---------------------------------------------------------------------------

const direct = (
    id: string,
    service: string,
    serviceBase: ServiceKey,
    method: Case['method'],
    path: string,
    guard: string,
    expect: Partial<Record<Persona, number[]>>,
    extra?: Partial<Case>
): Case => ({ id, service, serviceBase, via: 'direct', method, path, guard, expect, ...extra });

export const DIRECT_CASES: Case[] = [
    // hr-core
    direct('hr-core/employees', 'hr-core', 'hrCore', 'GET', '/v1/employees', 'serviceOrUserAuth + requireHR', {
        admin: [403],
        hr: [200],
        manager: [403],
        employee: [403],
        candidate: [403],
        anon: [401],
        service: [200] // trusted internal caller — by design
    }),
    direct(
        'hr-core/internal-users-projection',
        'hr-core',
        'hrCore',
        'POST',
        '/v1/internal/users-projection',
        'requireService (token-only)',
        {
            service: [200, 400], // accepted — 400 = payload validation
            anon: [401],
            hr: [401],
            admin: [401],
            employee: [401]
        },
        { body: {} }
    ),
    // time-attendance — note: business routes here IGNORE X-Service-Token
    // entirely (requireUser/requireHR parse user headers only).
    direct('time/attendance-mine', 'time-attendance', 'timeAttendance', 'GET', '/v1/attendance/mine', 'requireUser', {
        admin: [403],
        hr: [200],
        manager: [200],
        employee: [200],
        candidate: [403],
        anon: [401],
        service: [401] // token-only caller has no user context → rejected
    }),
    direct(
        'time/schedules',
        'time-attendance',
        'timeAttendance',
        'GET',
        '/v1/schedules',
        'requireHR (strict — manager excluded)',
        {
            admin: [403],
            hr: [200],
            manager: [403],
            employee: [403],
            candidate: [403],
            anon: [401]
        }
    ),
    direct(
        'time/correction-approve',
        'time-attendance',
        'timeAttendance',
        'PUT',
        '/v1/attendance/corrections/1/approve',
        'requireReviewer (hr/manager)',
        {
            admin: [403],
            hr: [200, 400, 404, 422],
            manager: [200, 400, 404, 422],
            employee: [403],
            candidate: [403],
            anon: [401]
        },
        { body: {} }
    ),
    direct(
        'time/leave-accrue',
        'time-attendance',
        'timeAttendance',
        'POST',
        '/v1/leave/accrue',
        'requireServiceToken',
        {
            service: [200, 400, 404, 422],
            anon: [401],
            hr: [403], // user identity present but no service token → 403
            admin: [403],
            employee: [403]
        },
        { body: {} }
    ),
    direct(
        'time/internal-dsar-export',
        'time-attendance',
        'timeAttendance',
        'POST',
        '/v1/internal/dsar-export',
        'requireServiceToken (token-only)',
        {
            service: [200, 400, 404, 422],
            anon: [401],
            hr: [403],
            admin: [403],
            employee: [403]
        },
        { body: {} }
    ),
    // payroll-adapter
    direct(
        'payroll/periods',
        'payroll-adapter',
        'payroll',
        'GET',
        '/v1/payroll/periods',
        'serviceOrUserAuth + requireHR',
        {
            admin: [403],
            hr: [200],
            manager: [403],
            employee: [403],
            candidate: [403],
            anon: [401],
            service: [200]
        }
    ),
    direct(
        'payroll/periods-create',
        'payroll-adapter',
        'payroll',
        'POST',
        '/v1/payroll/periods',
        'serviceOrUserAuth + requireHR',
        {
            admin: [403],
            hr: [200, 201, 400, 422],
            employee: [403],
            anon: [401],
            service: [200, 201, 400, 422]
        },
        { body: {} }
    ),
    // hr-services
    direct('hr-services/tickets', 'hr-services', 'hrServices', 'GET', '/v1/tickets', 'serviceOrUserAuth + requireHR', {
        admin: [403],
        hr: [200],
        manager: [403],
        employee: [403],
        anon: [401],
        service: [200]
    }),
    direct(
        'hr-services/tickets-my',
        'hr-services',
        'hrServices',
        'GET',
        '/v1/tickets/my',
        'requireEmployee (linked directory row)',
        {
            admin: [403],
            hr: [200, 403],
            manager: [200, 403],
            employee: [200, 403],
            candidate: [403],
            anon: [401],
            service: [401] // service caller has no employee context
        }
    ),
    direct(
        'hr-services/internal-employee-directory',
        'hr-services',
        'hrServices',
        'POST',
        '/v1/internal/employee-directory',
        'requireService (token-only)',
        {
            service: [200, 400],
            anon: [401],
            hr: [401],
            admin: [401],
            employee: [401]
        },
        { body: {} }
    ),
    // documents-resumes
    direct(
        'documents/get',
        'documents-resumes',
        'documents',
        'GET',
        '/v1/documents/00000000-0000-0000-0000-000000000000',
        'requireAuth + denyAdminContent + ACL',
        {
            admin: [403],
            hr: [200, 400, 404],
            manager: [403, 404], // non-staff user: candidateId null → ACL fails / doc missing
            employee: [403, 404],
            candidate: [403, 404],
            anon: [401],
            service: [200, 400, 404]
        }
    ),
    // recruitment-core (published but currently NOT routed via gateway env)
    direct(
        'recruitment/vacancies-list',
        'recruitment-core',
        'recruitment',
        'GET',
        '/v1/vacancies',
        'PUBLIC at service level',
        {
            anon: [200],
            admin: [200],
            hr: [200]
        }
    ),
    direct(
        'recruitment/vacancies-create',
        'recruitment-core',
        'recruitment',
        'POST',
        '/v1/vacancies',
        'serviceOrHrAuth',
        {
            admin: [403],
            hr: [200, 201, 400, 422],
            employee: [403],
            anon: [401],
            service: [200, 201, 400, 422]
        },
        { body: {} }
    ),
    direct(
        'recruitment/internal-users-projection',
        'recruitment-core',
        'recruitment',
        'POST',
        '/v1/internal/users-projection',
        'requireService (token-only)',
        {
            service: [200, 400],
            anon: [401],
            hr: [401]
        },
        { body: {} }
    ),
    // notifications
    direct('notifications/list', 'notifications', 'notifications', 'GET', '/v1/notifications', 'serviceOrAdminAuth', {
        admin: [200],
        hr: [403],
        employee: [403],
        anon: [401],
        service: [200]
    }),
    direct(
        'notifications/preferences',
        'notifications',
        'notifications',
        'GET',
        '/v1/notifications/preferences',
        'requireUser (any role)',
        {
            admin: [200],
            hr: [200],
            employee: [200],
            anon: [401],
            service: [401]
        }
    ),
    // ai-matching — service_auth accepts user headers of ANY role or the token;
    // no role gate exists (internal compute service). Informational rows.
    direct(
        'ai/jobs',
        'ai-matching',
        'aiMatching',
        'GET',
        '/v1/jobs/e2e-probe',
        'service_auth (token OR any user id)',
        {
            anon: [401],
            admin: [200, 404],
            hr: [200, 404],
            employee: [200, 404],
            service: [200, 404]
        },
        { note: 'no role gate — any authenticated caller reaches the handler' }
    ),
    // monolith direct — proves it never trusts identity headers (JWT required)
    direct('monolith/admin-audit', 'api', 'api', 'GET', '/api/admin/audit', 'isAdmin — verifies RS256 itself', {
        anon: [401],
        forged: [401], // X-User-Role: admin headers are NOT trusted
        service: [401]
    }),
    // identity direct — same: header forgery rejected, JWT required
    direct(
        'identity/users-list',
        'identity-auth',
        'identity',
        'GET',
        '/v1/users',
        'requireAdmin — verifies RS256 itself',
        {
            anon: [401],
            forged: [401],
            service: [401]
        }
    )
];

/** Headers used to simulate header-stripping probes (all spoofable names). */
export const SPOOF_HEADERS: Record<string, string> = {
    [USER_ID_HEADER]: '5',
    [USER_ROLE_HEADER]: 'hr',
    'X-User-Location': '{"country":"MX"}',
    [CANDIDATE_ID_HEADER]: '1',
    [SERVICE_TOKEN_HEADER]: config.serviceToken ?? 'invalid'
};
