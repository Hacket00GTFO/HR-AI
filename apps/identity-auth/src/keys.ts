import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exportJWK, importPKCS8, importSPKI, type KeyLike, type JWK } from 'jose';
import { logger } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';

export interface KeySet {
    privateKey: KeyLike;
    publicKey: KeyLike;
    /** Stable key id embedded in JWK + token headers so JWKS clients match. */
    kid: string;
    publicJwk: JWK;
}

function readPemFile(p: string | undefined, fallbackName: string): string | undefined {
    const file = p || path.join(process.cwd(), 'keys', fallbackName);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    return undefined;
}

/**
 * Resolve the RS256 keypair. Precedence:
 *   1. JWT_PRIVATE_KEY / JWT_PUBLIC_KEY env (PEM, '\n' escapes allowed)
 *   2. *_FILE env or ./keys/{private,public}.pem
 *   3. JWT_GENERATE_KEYS=true → ephemeral in-memory pair (dev/CI only)
 */
export async function loadKeys(config: ServiceConfig): Promise<KeySet> {
    let privatePem = config.jwtPrivateKey;
    let publicPem = config.jwtPublicKey;

    if (!privatePem) privatePem = readPemFile(config.jwtPrivateKeyFile, 'private.pem');
    if (!publicPem) publicPem = readPemFile(config.jwtPublicKeyFile, 'public.pem');

    if (!privatePem || !publicPem) {
        if (!config.generateKeys) {
            throw new Error(
                'No RS256 key material found. Set JWT_PRIVATE_KEY/JWT_PUBLIC_KEY, ' +
                    'provide keys/*.pem files, run `pnpm genkeys`, or set JWT_GENERATE_KEYS=true (dev only).'
            );
        }
        logger.warn('JWT_GENERATE_KEYS=true — generating ephemeral RSA keypair (tokens die on restart)');
        const pair = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        privatePem = pair.privateKey;
        publicPem = pair.publicKey;
    }

    const privateKey = await importPKCS8(privatePem, 'RS256');
    const publicKey = await importSPKI(publicPem, 'RS256');

    // Deterministic kid: sha256 thumbprint of the public PEM.
    const kid = crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);

    const jwk = await exportJWK(publicKey);
    const publicJwk: JWK = { ...jwk, kid, alg: 'RS256', use: 'sig' };

    return { privateKey, publicKey, kid, publicJwk };
}
