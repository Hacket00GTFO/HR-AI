import type { ClientRequest } from 'node:http';
import type { Request, RequestHandler, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { logger, CORRELATION_HEADER } from '@strafor/node-common';
import {
    USER_ID_HEADER,
    USER_ROLE_HEADER,
    USER_LOCATION_HEADER,
    CANDIDATE_ID_HEADER,
    SERVICE_TOKEN_HEADER,
    type VerifiedClaims
} from './auth.js';
import type { RouteDecision } from './routes.js';

interface ProxyOptions {
    /** Fallback target — the router function decides the real upstream. */
    target: string;
    timeoutMs: number;
    /** Per-request route decision (target + whether to strip /api). */
    dynamic?: (req: Request) => RouteDecision;
}

function onProxyReq(proxyReq: ClientRequest, req: Request): void {
    // Propagate the correlation id to every upstream.
    const cid = req.correlationId;
    if (cid) proxyReq.setHeader(CORRELATION_HEADER, cid);

    // Verified identity headers (v1 routes) — injected here so client-supplied
    // values are always overwritten.
    const claims = (req as Request & { claims?: VerifiedClaims }).claims;
    proxyReq.removeHeader(USER_ID_HEADER);
    proxyReq.removeHeader(USER_ROLE_HEADER);
    proxyReq.removeHeader(USER_LOCATION_HEADER);
    // Belt-and-suspenders: these are already stripped inbound, but the proxy
    // must never forward a client-supplied candidate id or service token.
    proxyReq.removeHeader(CANDIDATE_ID_HEADER);
    proxyReq.removeHeader(SERVICE_TOKEN_HEADER);
    if (claims?.sub) proxyReq.setHeader(USER_ID_HEADER, claims.sub);
    if (claims?.role) proxyReq.setHeader(USER_ROLE_HEADER, claims.role);
    if (claims?.location !== undefined && claims.location !== null) {
        proxyReq.setHeader(
            USER_LOCATION_HEADER,
            typeof claims.location === 'string' ? claims.location : JSON.stringify(claims.location)
        );
    }
}

function onError(err: Error, _req: unknown, res: unknown): void {
    logger.error({ err: err.message }, 'upstream proxy error');
    const r = res as {
        headersSent?: boolean;
        writeHead?: (s: number, h: Record<string, string>) => void;
        end?: (b?: string) => void;
        status?: (s: number) => { json: (b: unknown) => void };
    };
    const body = { error: 'Upstream service unavailable' };
    if (r.headersSent) {
        r.end?.(JSON.stringify(body));
        return;
    }
    if (typeof r.status === 'function') {
        r.status(502).json(body);
    } else {
        r.writeHead?.(502, { 'Content-Type': 'application/json' });
        r.end?.(JSON.stringify(body));
    }
}

/** Build a proxy middleware. */
export function makeProxy(opts: ProxyOptions): RequestHandler {
    return createProxyMiddleware<Request, Response>({
        target: opts.target,
        changeOrigin: true,
        ...(opts.dynamic
            ? {
                  router: (req: Request) => opts.dynamic!(req).target,
                  pathRewrite: (path: string, req: Request) => {
                      const d = opts.dynamic!(req);
                      // Explicit rewrites win (monolith fallbacks need
                      // /api/v1/x → /api/x); otherwise /api/v1/x → /v1/x for
                      // extracted services; legacy /api/* and non-/api pass
                      // through verbatim.
                      if (d.rewrite) return d.rewrite(path);
                      return d.stripApiPrefix ? path.replace(/^\/api/, '') : path;
                  }
              }
            : {}),
        timeout: opts.timeoutMs,
        proxyTimeout: opts.timeoutMs,
        on: {
            proxyReq: onProxyReq,
            error: onError
        }
    });
}
