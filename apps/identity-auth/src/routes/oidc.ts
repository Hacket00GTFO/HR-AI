import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { logger } from '@strafor/node-common';
import type { RouteDeps } from './auth.js';
import { query } from '../db.js';

/**
 * OIDC / SSO routes — DEV PLUMBING (Keycloak via infra/compose, profile `sso`).
 *
 * Status: the authorization-request leg (/login) is real; the callback is a
 * documented stub. Config is validated at boot (src/config.ts):
 *
 *   OIDC_ISSUER         e.g. http://localhost:8081/realms/strafor   (required to enable)
 *   OIDC_CLIENT_ID      e.g. strafor-web                          (required to enable)
 *   OIDC_CLIENT_SECRET  confidential-client secret                (optional — public clients)
 *   OIDC_REDIRECT_URI   defaults to ${PUBLIC_BASE_URL}/v1/auth/oidc/callback
 *
 * ---------------------------------------------------------------------------
 * DESIGN — authorization-code flow to be implemented in the callback:
 *
 *  1. GET /v1/auth/oidc/login
 *     - generate `state` (random, stored server-side in Redis `oidc:state:<state>`
 *       with ~10min TTL; binds the callback to this browser session) and
 *       `nonce` (stored alongside, later checked against the id_token)
 *     - 302 → {OIDC_ISSUER}/protocol/openid-connect/auth?
 *             client_id, redirect_uri, response_type=code,
 *             scope=openid email profile, state, nonce
 *     (implemented below — state persistence is in Postgres `oidc_states`
 *      as a Redis-free fallback; swap to Redis when available)
 *
 *  2. GET /v1/auth/oidc/callback?code&state
 *     - look up + consume `state` (single use); mismatch/expired → 401
 *     - POST {issuer}/protocol/openid-connect/token
 *         grant_type=authorization_code, code, redirect_uri,
 *         client_id, client_secret (confidential client)
 *     - verify the returned id_token against {issuer}/protocol/openid-connect/certs
 *       (JWKS, RS256 — reuse the jose jwtVerify pattern from tokens.ts with a
 *       remote JWKS via createRemoteJWKSet), check iss/aud/nonce/exp
 *     - resolve the local user by id_token `email` claim
 *       (auto-provision policy TBD — likely map to users.email, refuse unknown)
 *     - run the SAME MFA gate as password login: if user.mfa_enabled → issue
 *       an MFA challenge token (signMfaChallengeToken) and redirect the
 *       browser to the web app's MFA page; else issue tokens + flag
 *       mfa_setup_required
 *     - audit: auth.login with metadata {method: 'oidc', provider: issuer}
 *
 *  3. Session issuance identical to /v1/auth/login — RS256 access token +
 *     rotating refresh family — so the gateway and BFF need no changes.
 * ---------------------------------------------------------------------------
 */
export function oidcRouter(deps: RouteDeps): Router {
    const router = Router();
    const { config } = deps;

    function oidcEnabled(res: Response): boolean {
        if (!config.oidcIssuer || !config.oidcClientId) {
            res.status(501).json({
                error: 'OIDC not configured',
                details: 'Set OIDC_ISSUER and OIDC_CLIENT_ID (see infra/compose Keycloak service, profile `sso`)'
            });
            return false;
        }
        return true;
    }

    // ---- GET /v1/auth/oidc/login — redirect to the IdP authorization endpoint ----
    router.get('/login', async (req: Request, res: Response) => {
        if (!oidcEnabled(res)) return;
        try {
            const state = crypto.randomBytes(24).toString('base64url');
            const nonce = crypto.randomBytes(24).toString('base64url');
            // Persist state for callback validation (see design block above).
            await query(
                `INSERT INTO oidc_states (state, nonce, expires_at)
                 VALUES ($1, $2, now() + interval '10 minutes')
                 ON CONFLICT (state) DO NOTHING`,
                [state, nonce]
            );

            const params = new URLSearchParams({
                client_id: config.oidcClientId!,
                redirect_uri: config.oidcRedirectUri!,
                response_type: 'code',
                scope: 'openid email profile',
                state,
                nonce
            });
            const issuer = config.oidcIssuer!.replace(/\/$/, '');
            res.redirect(`${issuer}/protocol/openid-connect/auth?${params.toString()}`);
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'oidc login error');
            res.status(500).json({ error: 'Error initiating SSO login' });
        }
    });

    // ---- GET /v1/auth/oidc/callback — STUB (see design block at top of file) ----
    router.get('/callback', async (_req: Request, res: Response) => {
        if (!oidcEnabled(res)) return;
        res.status(501).json({
            error: 'OIDC callback not implemented',
            details: 'Authorization-code exchange is documented in src/routes/oidc.ts'
        });
    });

    return router;
}

export default oidcRouter;
