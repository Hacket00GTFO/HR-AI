// Token + identity helpers for the role-matrix suite.
//
// Three credential shapes exist in this platform:
//
//   1. Real RS256 access tokens — minted by identity-auth via
//      POST /api/v1/auth/login. Requires a seeded user; identity's users table
//      only admits roles 'admin' and 'hr' (CHECK constraint), so those are the
//      only JWT personas available against a stock stack.
//   2. Test-key RS256 tokens — mintRs256() signs locally with
//      E2E_TEST_PRIVATE_KEY. They validate against the gateway ONLY when
//      identity-auth runs with the same key material (JWT_PRIVATE_KEY /
//      JWT_PUBLIC_KEY) so the served JWKS contains the matching public key.
//      With JWT_GENERATE_KEYS=true (the dev default) identity's keypair is
//      ephemeral and these tokens are rejected — use login() instead.
//   3. Asserted identity headers — X-User-Id / X-User-Role sent DIRECTLY to a
//      service port. This is the platform's internal trust model: the gateway
//      injects them from verified JWT claims after stripping client-supplied
//      copies. Used to exercise roles identity cannot issue
//      (employee/manager/candidate).
import crypto from 'node:crypto';
import { req } from './http.js';
import { config } from './env.js';

export type UserRole = 'admin' | 'hr' | 'manager' | 'employee' | 'candidate';
/** 'service' = X-Service-Token only; 'anon' = no credentials; 'forged' =
 *  X-User-* headers without a JWT (gateway must strip + reject). */
export type Persona = UserRole | 'service' | 'anon' | 'forged';

export const USER_ID_HEADER = 'X-User-Id';
export const USER_ROLE_HEADER = 'X-User-Role';
export const EMPLOYEE_ID_HEADER = 'X-Employee-Id';
export const CANDIDATE_ID_HEADER = 'X-Candidate-Id';
export const SERVICE_TOKEN_HEADER = 'X-Service-Token';

/** Headers a trusted internal caller sends to assert an end-user identity. */
export function asserted(role: UserRole, userId: number, employeeId?: number): Record<string, string> {
    const h: Record<string, string> = {
        [USER_ID_HEADER]: String(userId),
        [USER_ROLE_HEADER]: role
    };
    if (employeeId !== undefined) h[EMPLOYEE_ID_HEADER] = String(employeeId);
    return h;
}

export function serviceAuth(token = config.serviceToken): Record<string, string> {
    if (!token) throw new Error('service token not configured (E2E_SERVICE_TOKEN / .env)');
    return { [SERVICE_TOKEN_HEADER]: token };
}

export function bearer(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
}

/** Real login against identity-auth through the gateway (public path). */
export async function login(baseUrl: string, email: string, password: string): Promise<string> {
    const res = await req(baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: { email, password }
    });
    const body = res.body as { accessToken?: string; mfa_required?: boolean };
    if (res.status !== 200 || !body.accessToken) {
        throw new Error(`login failed for ${email}: HTTP ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);
    }
    return body.accessToken;
}

export interface AccessClaims {
    sub: string;
    email?: string;
    role?: string;
    jti?: string;
    iss?: string;
    exp?: number;
}

/** Decode (NOT verify) a JWT payload — used to discover the seeded user id. */
export function decodeClaims(token: string): AccessClaims {
    const payload = token.split('.')[1];
    if (!payload) throw new Error('malformed JWT');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessClaims;
}

// ---- Test-key RS256 minting ------------------------------------------------

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

/** Deterministic kid identical to identity-auth's (sha256 of public PEM). */
export function kidForPublicPem(publicPem: string): string {
    return crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
}

/**
 * Sign an RS256 access token with a local private key. The token validates at
 * the gateway only when identity-auth serves the matching public key in its
 * JWKS — i.e. the stack was booted with JWT_PRIVATE_KEY/JWT_PUBLIC_KEY set to
 * this pair. With JWT_GENERATE_KEYS=true these tokens are (correctly) 401.
 */
export function mintRs256(
    claims: { sub: string | number; role: UserRole; email?: string },
    privatePem: string,
    publicPem: string,
    opts: { issuer?: string; ttlSeconds?: number } = {}
): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: kidForPublicPem(publicPem) };
    const payload = {
        iss: opts.issuer ?? 'strafor-identity',
        sub: String(claims.sub),
        role: claims.role,
        ...(claims.email ? { email: claims.email } : {}),
        jti: crypto.randomUUID(),
        iat: now,
        exp: now + (opts.ttlSeconds ?? 900)
    };
    const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), privatePem);
    return `${signingInput}.${b64u(signature)}`;
}

export function generateTestKeyPair(): { privatePem: string; publicPem: string } {
    const pair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    return { privatePem: pair.privateKey, publicPem: pair.publicKey };
}
