import crypto from 'node:crypto';
import { hashToken } from './tokens.js';

// ---- base32 (RFC 4648) encoding ----
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
    }
    return output;
}

export function base32Decode(input: string): Buffer {
    const cleaned = input.replace(/=+$/, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of cleaned) {
        const idx = BASE32_ALPHABET.indexOf(char);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

// ---- TOTP (RFC 6238) using HMAC-SHA1 ----
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function generateTotp(
    secretBase32: string,
    counter: number = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS)
): string {
    const key = base32Decode(secretBase32);
    const counterBuffer = Buffer.alloc(8);
    // Write counter as 64-bit big-endian
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
    const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
    const b0 = hmac[offset] ?? 0;
    const b1 = hmac[offset + 1] ?? 0;
    const b2 = hmac[offset + 2] ?? 0;
    const b3 = hmac[offset + 3] ?? 0;
    const binary = ((b0 & 0x7f) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff);
    const code = binary % 10 ** TOTP_DIGITS;
    return code.toString().padStart(TOTP_DIGITS, '0');
}

/** Verify a TOTP code allowing for clock drift of ±1 time step. */
export function verifyTotp(secretBase32: string, code: string): boolean {
    if (typeof code !== 'string' || !/^\d+$/.test(code) || code.length !== TOTP_DIGITS) return false;
    const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    for (const drift of [-1, 0, 1]) {
        if (generateTotp(secretBase32, counter + drift) === code) return true;
    }
    return false;
}

/** Fresh TOTP shared secret (160 bits, base32 — authenticator-app compatible). */
export function generateTotpSecret(): string {
    return base32Encode(crypto.randomBytes(20));
}

// ---- Recovery codes ----
// One-time fallback codes shown ONCE at enrollment; only sha256 hashes are
// persisted (users.mfa_backup_codes jsonb). Format: XXXX-XXXX (base32).
export const RECOVERY_CODE_COUNT = 8;

export function generateRecoveryCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        const raw = base32Encode(crypto.randomBytes(5)); // 8 chars
        codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    }
    return codes;
}

/** Normalize user input ('abcd-1234', 'abcd 1234', lowercase) → 'ABCD1234'. */
export function normalizeRecoveryCode(code: string): string {
    return code.replace(/[-\s]/g, '').toUpperCase();
}

export function hashRecoveryCode(code: string): string {
    return hashToken(normalizeRecoveryCode(code));
}
