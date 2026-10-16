import type { GatewayConfig } from './config.js';

export interface RouteDecision {
    /** Upstream base URL. */
    target: string;
    /** Strip the `/api` prefix so upstream sees `/v1/...` (extracted services). */
    stripApiPrefix: boolean;
    /**
     * Optional full-path rewrite — takes precedence over stripApiPrefix.
     * Used for monolith fallbacks: recruitment paths served by the legacy
     * monolith live under /api/* (not /v1/*), so a fallback must rewrite
     * /api/v1/x → /api/x rather than handing the monolith a path it 404s.
     */
    rewrite?: (path: string) => string;
}

/** /api/v1/x → /api/x — the legacy monolith mounts routes under /api. */
const toMonolithPath = (path: string): string => path.replace(/^\/api\/v1/, '/api');

/**
 * Route table. Order matters — first match wins.
 *   /api/v1/{auth,users,settings}/*        → IDENTITY_URL
 *   /api/v1/documents/*                    → DOCUMENTS_URL
 *   /api/v1/notifications/*                → NOTIFICATIONS_URL
 *   /api/v1/{match,ai}/*                   → AI_SERVICE_URL
 *   /api/v1/{employees,hr,org}/*           → HR_CORE_URL      (fallback: API_URL)
 *   /api/v1/vacancies/*                    → RECRUITMENT_CORE_URL → VACANCIES_URL → API_URL
 *   /api/v1/{candidates,applications}/*    → RECRUITMENT_CORE_URL → CANDIDATES_URL → API_URL
 *   /api/v1/{public,recruitment}/*         → RECRUITMENT_CORE_URL → API_URL
 *   /api/v1/ai/process-feedback            → RECRUITMENT_CORE_URL → API_URL
 *   /api/v1/ai/* (rest)                    → AI_SERVICE_URL     (fallback: API_URL)
 *   all other /api/*                       → API_URL (legacy monolith, path kept)
 *   non-/api/*                             → STATIC_FALLBACK_URL || API_URL
 *
 * V1 routes strip the `/api` prefix; legacy paths are forwarded verbatim.
 * Recruitment fallbacks to the monolith additionally rewrite /api/v1 → /api
 * (the monolith mounts the domain under /api, not /v1) so rollback keeps
 * working; other services' fallbacks stay nominal.
 */
export function resolveUpstream(path: string, config: GatewayConfig): RouteDecision {
    const api = config.apiUrl;
    const v1 = path === '/api/v1' || path.startsWith('/api/v1/');

    if (v1) {
        const sub = path.slice('/api/v1'.length); // '/auth/login' etc.
        const first = sub.split('/')[1] ?? '';
        const recruitment = config.recruitmentCoreUrl;

        let target: string;
        // true when the decision falls back to the legacy monolith — the
        // path must be rewritten /api/v1/x → /api/x for it to resolve.
        let monolithFallback = false;
        switch (first) {
            case 'auth':
            case 'users':
            case 'settings':
                target = config.identityUrl;
                break;
            case 'documents':
                target = config.documentsUrl ?? api;
                break;
            case 'notifications':
                target = config.notificationsUrl ?? api;
                break;
            case 'ai':
                // /api/v1/ai/process-feedback moved into recruitment-core;
                // every other /api/v1/ai/* still goes to ai-matching.
                if (sub === '/ai/process-feedback') {
                    target = recruitment ?? api;
                    monolithFallback = !recruitment;
                } else {
                    target = config.aiServiceUrl ?? api;
                }
                break;
            case 'match':
                target = config.aiServiceUrl ?? api;
                break;
            case 'vacancies':
                target = recruitment ?? config.vacanciesUrl ?? api;
                monolithFallback = !recruitment && !config.vacanciesUrl;
                break;
            case 'candidates':
            case 'applications':
                target = recruitment ?? config.candidatesUrl ?? api;
                monolithFallback = !recruitment && !config.candidatesUrl;
                break;
            case 'public':
            case 'recruitment':
                target = recruitment ?? api;
                monolithFallback = !recruitment;
                break;
            case 'employees':
            case 'hr':
            case 'org':
                target = config.hrCoreUrl ?? api;
                monolithFallback = !config.hrCoreUrl;
                break;
            case 'attendance':
            case 'leave':
            case 'schedules':
                target = config.timeAttendanceUrl ?? api;
                monolithFallback = !config.timeAttendanceUrl;
                break;
            case 'payroll':
                target = config.payrollAdapterUrl ?? api;
                monolithFallback = !config.payrollAdapterUrl;
                break;
            case 'tickets':
            case 'assets':
            case 'expenses':
            case 'surveys':
                target = config.hrServicesUrl ?? api;
                monolithFallback = !config.hrServicesUrl;
                break;
            case 'calendar':
                target = config.calendarBridgeUrl ?? api;
                monolithFallback = !config.calendarBridgeUrl;
                break;
            default:
                target = api;
        }
        // Any v1 path resolved to the monolith — including legacy
        // VACANCIES_URL/CANDIDATES_URL vars that point AT the monolith —
        // needs /api/v1/x → /api/x (the monolith mounts under /api only).
        if (target === api) monolithFallback = true;
        return {
            target,
            stripApiPrefix: true,
            ...(monolithFallback ? { rewrite: toMonolithPath } : {})
        };
    }

    if (path === '/api' || path.startsWith('/api/')) {
        return { target: api, stripApiPrefix: false };
    }

    return { target: config.staticFallbackUrl ?? api, stripApiPrefix: false };
}

/**
 * Public allowlist for the /api/v1 JWT guard — METHOD-AWARE.
 * `sub` is the path after '/api/v1' WITHOUT a leading slash ('auth/login',
 * 'health', ...). Everything else under /api/v1 requires a valid RS256 token.
 *
 * Anonymous surface:
 *   - GET  /api/v1/vacancies        public careers listing only — vacancy
 *                                 detail (GET vacancies/:id) stays HR-gated
 *                                 downstream exactly like the monolith
 *   - POST /api/v1/public/apply     anonymous job application (rate-limited
 *                                 upstream, 20/hour/IP)
 *   - GET  /api/v1/public/*         read-only public data (jobs listings etc.)
 *   - auth/*  + health              identity flows (all methods — login etc.)
 * Any other method on public/* requires JWT — the old blanket `public/`
 * rule let anonymous clients hit ANY verb.
 */
export function isPublicV1Path(sub: string, method: string = 'GET'): boolean {
    if (sub === 'health') return true;
    if (sub === 'auth/login' || sub === 'auth/refresh') return true;
    if (sub.startsWith('auth/password/')) return true;
    if (method === 'GET' && sub === 'vacancies') return true;
    if (sub === 'public/apply') return method === 'POST';
    if (sub.startsWith('public/')) return method === 'GET';
    return false;
}
