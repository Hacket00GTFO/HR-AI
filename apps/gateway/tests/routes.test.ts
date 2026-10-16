import { describe, it, expect } from 'vitest';
import { resolveUpstream, isPublicV1Path } from '../src/routes.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';

const cfg = (over: Partial<GatewayConfig> = {}): GatewayConfig =>
    loadConfig(
        {},
        {
            apiUrl: 'http://api:3000',
            identityUrl: 'http://identity:3001',
            identityJwksUrl: 'http://identity:3001/.well-known/jwks.json',
            ...over
        }
    );

describe('route table', () => {
    it('maps identity routes', () => {
        const c = cfg();
        for (const p of ['/api/v1/auth/login', '/api/v1/users', '/api/v1/users/3', '/api/v1/settings']) {
            const d = resolveUpstream(p, c);
            expect(d.target).toBe('http://identity:3001');
            expect(d.stripApiPrefix).toBe(true);
        }
    });

    it('maps documents/notifications/ai routes', () => {
        const c = cfg({
            documentsUrl: 'http://docs:3004',
            notificationsUrl: 'http://notif:3007',
            aiServiceUrl: 'http://ai:3005'
        });
        expect(resolveUpstream('/api/v1/documents/9', c).target).toBe('http://docs:3004');
        expect(resolveUpstream('/api/v1/notifications/send', c).target).toBe('http://notif:3007');
        expect(resolveUpstream('/api/v1/match/run', c).target).toBe('http://ai:3005');
        expect(resolveUpstream('/api/v1/ai/score', c).target).toBe('http://ai:3005');
    });

    it('vacancies/candidates fall back to the monolith when unset', () => {
        const c = cfg();
        expect(resolveUpstream('/api/v1/vacancies', c).target).toBe('http://api:3000');
        expect(resolveUpstream('/api/v1/candidates', c).target).toBe('http://api:3000');
        expect(resolveUpstream('/api/v1/applications/4', c).target).toBe('http://api:3000');

        const c2 = cfg({ vacanciesUrl: 'http://vac:3002', candidatesUrl: 'http://cand:3003' });
        expect(resolveUpstream('/api/v1/vacancies', c2).target).toBe('http://vac:3002');
        expect(resolveUpstream('/api/v1/candidates', c2).target).toBe('http://cand:3003');
    });

    it('recruitment-core wins over the legacy per-service urls', () => {
        const c = cfg({
            recruitmentCoreUrl: 'http://rec:3009',
            vacanciesUrl: 'http://vac:3002',
            candidatesUrl: 'http://cand:3003',
            aiServiceUrl: 'http://ai:3005'
        });
        for (const p of [
            '/api/v1/vacancies',
            '/api/v1/vacancies/3/top-candidates',
            '/api/v1/candidates',
            '/api/v1/applications/4',
            '/api/v1/public/apply',
            '/api/v1/recruitment/anything',
            '/api/v1/ai/process-feedback'
        ]) {
            const d = resolveUpstream(p, c);
            expect(d.target).toBe('http://rec:3009');
            expect(d.stripApiPrefix).toBe(true);
            expect(d.rewrite).toBeUndefined();
        }
        // Other /api/v1/ai/* still goes to ai-matching.
        expect(resolveUpstream('/api/v1/ai/score', c).target).toBe('http://ai:3005');
        expect(resolveUpstream('/api/v1/match/run', c).target).toBe('http://ai:3005');
    });

    it('monolith fallback rewrites /api/v1/* → /api/* for recruitment paths', () => {
        const c = cfg(); // no recruitmentCoreUrl → legacy monolith rollback
        for (const [incoming, upstream] of [
            ['/api/v1/vacancies', '/api/vacancies'],
            ['/api/v1/candidates/7/status', '/api/candidates/7/status'],
            ['/api/v1/applications/4', '/api/applications/4'],
            ['/api/v1/public/apply', '/api/public/apply'],
            ['/api/v1/ai/process-feedback', '/api/ai/process-feedback']
        ] as const) {
            const d = resolveUpstream(incoming, c);
            expect(d.target).toBe('http://api:3000');
            expect(d.rewrite).toBeTypeOf('function');
            expect(d.rewrite!(incoming)).toBe(upstream);
        }
        // The old per-service env vars still win over the monolith fallback
        // and do NOT rewrite (they are v1 services).
        const c2 = cfg({ vacanciesUrl: 'http://vac:3002' });
        const d2 = resolveUpstream('/api/v1/vacancies', c2);
        expect(d2.target).toBe('http://vac:3002');
        expect(d2.rewrite).toBeUndefined();
        // ...but a legacy per-service var pointing AT the monolith itself
        // must still rewrite — the monolith does not serve /v1 paths.
        const c3 = cfg({ vacanciesUrl: 'http://api:3000' });
        const d3 = resolveUpstream('/api/v1/vacancies', c3);
        expect(d3.target).toBe('http://api:3000');
        expect(d3.rewrite).toBeTypeOf('function');
        expect(d3.rewrite!('/api/v1/vacancies')).toBe('/api/vacancies');
    });

    it('hr/time/payroll routes target extracted services and fall back to the monolith with rewrite', () => {
        const c = cfg({
            hrCoreUrl: 'http://hr-core:3010',
            timeAttendanceUrl: 'http://time:3011',
            payrollAdapterUrl: 'http://payroll:3012',
            hrServicesUrl: 'http://hr-svc:3014',
            calendarBridgeUrl: 'http://calendar:3016'
        });
        for (const [incoming, upstream] of [
            ['/api/v1/employees', 'http://hr-core:3010'],
            ['/api/v1/hr/departments', 'http://hr-core:3010'],
            ['/api/v1/org/tree', 'http://hr-core:3010'],
            ['/api/v1/attendance/check-in', 'http://time:3011'],
            ['/api/v1/leave/requests', 'http://time:3011'],
            ['/api/v1/schedules/2', 'http://time:3011'],
            ['/api/v1/payroll/runs', 'http://payroll:3012'],
            ['/api/v1/tickets/my', 'http://hr-svc:3014'],
            ['/api/v1/assets/3/checkout', 'http://hr-svc:3014'],
            ['/api/v1/expenses/my', 'http://hr-svc:3014'],
            ['/api/v1/surveys/2/results', 'http://hr-svc:3014'],
            ['/api/v1/calendar/free-busy', 'http://calendar:3016'],
            ['/api/v1/calendar/events', 'http://calendar:3016']
        ] as const) {
            const d = resolveUpstream(incoming, c);
            expect(d.target).toBe(upstream);
            expect(d.stripApiPrefix).toBe(true);
            expect(d.rewrite).toBeUndefined();
        }

        // Without the service URLs the monolith gets the request rewritten
        // to its legacy /api/* shape.
        const legacy = cfg();
        for (const [incoming, upstream] of [
            ['/api/v1/employees', '/api/employees'],
            ['/api/v1/hr/departments', '/api/hr/departments'],
            ['/api/v1/attendance/check-in', '/api/attendance/check-in'],
            ['/api/v1/leave/requests', '/api/leave/requests'],
            ['/api/v1/payroll/runs', '/api/payroll/runs']
        ] as const) {
            const d = resolveUpstream(incoming, legacy);
            expect(d.target).toBe('http://api:3000');
            expect(d.rewrite).toBeTypeOf('function');
            expect(d.rewrite!(incoming)).toBe(upstream);
        }
    });

    it('unknown /api/v1/* and legacy /api/* go to the monolith', () => {
        const c = cfg();
        expect(resolveUpstream('/api/v1/unknown-thing', c).target).toBe('http://api:3000');
        const legacy = resolveUpstream('/api/candidates', c);
        expect(legacy.target).toBe('http://api:3000');
        expect(legacy.stripApiPrefix).toBe(false);
    });

    it('non-/api paths go to STATIC_FALLBACK_URL or the monolith', () => {
        expect(resolveUpstream('/dashboard', cfg()).target).toBe('http://api:3000');
        const c = cfg({ staticFallbackUrl: 'http://web:3010' });
        expect(resolveUpstream('/dashboard', c).target).toBe('http://web:3010');
        expect(resolveUpstream('/', c).stripApiPrefix).toBe(false);
    });
});

describe('v1 public allowlist (method-aware)', () => {
    it('allows login/refresh/password-forgot/reset/health', () => {
        for (const p of ['auth/login', 'auth/refresh', 'auth/password/forgot', 'auth/password/reset', 'health']) {
            expect(isPublicV1Path(p, 'POST')).toBe(true);
            expect(isPublicV1Path(p, 'GET')).toBe(true);
        }
    });

    it('anonymous careers listing: GET vacancies only', () => {
        expect(isPublicV1Path('vacancies', 'GET')).toBe(true);
        // Detail + every other method require JWT (same as the monolith).
        expect(isPublicV1Path('vacancies/12', 'GET')).toBe(false);
        expect(isPublicV1Path('vacancies', 'POST')).toBe(false);
        expect(isPublicV1Path('vacancies/12', 'DELETE')).toBe(false);
    });

    it('anonymous apply: POST public/apply only; other public/* GET-only', () => {
        expect(isPublicV1Path('public/apply', 'POST')).toBe(true);
        expect(isPublicV1Path('public/apply', 'GET')).toBe(false);
        expect(isPublicV1Path('public/jobs', 'GET')).toBe(true);
        // The old blanket rule allowed ANY method on public/* — closed.
        expect(isPublicV1Path('public/jobs', 'POST')).toBe(false);
        expect(isPublicV1Path('public/jobs', 'DELETE')).toBe(false);
    });

    it('requires auth elsewhere', () => {
        for (const p of ['users', 'users/1', 'settings', 'auth/logout', 'auth/register', 'candidates']) {
            expect(isPublicV1Path(p, 'GET')).toBe(false);
            expect(isPublicV1Path(p, 'POST')).toBe(false);
        }
    });
});
