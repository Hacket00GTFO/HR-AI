#!/usr/bin/env node
/**
 * Generate an RSA-2048 keypair for RS256 token signing.
 *
 *   node scripts/genkeys.js            → writes keys/private.pem + keys/public.pem (0600)
 *   node scripts/genkeys.js --env      → prints JWT_PRIVATE_KEY/JWT_PUBLIC_KEY .env lines
 *
 * keys/ is gitignored. The public key is exposed via /.well-known/jwks.json;
 * keep the private key secret.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const asEnv = process.argv.includes('--env');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

if (asEnv) {
    const esc = (pem) => pem.replace(/\n/g, '\\n');
    console.log(`JWT_PRIVATE_KEY="${esc(privateKey)}"`);
    console.log(`JWT_PUBLIC_KEY="${esc(publicKey)}"`);
    process.exit(0);
}

const keysDir = path.join(__dirname, '..', 'keys');
fs.mkdirSync(keysDir, { recursive: true });

const privPath = path.join(keysDir, 'private.pem');
const pubPath = path.join(keysDir, 'public.pem');

if (fs.existsSync(privPath) && !process.argv.includes('--force')) {
    console.error(`Refusing to overwrite existing ${privPath} (pass --force to rotate).`);
    process.exit(1);
}

fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });

console.log(`Wrote ${privPath} and ${pubPath}`);
console.log('Distribute the PUBLIC key (or the JWKS endpoint) to verifying services only.');
