import crypto from 'node:crypto';

/**
 * AES-256-GCM field encryption for settings secrets at rest.
 * Stored format:  enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 */
const PREFIX = 'enc:v1:';

export function isEncrypted(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptField(plain: string, key: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptField(stored: string, key: Buffer): string {
    if (!isEncrypted(stored)) return stored;
    const parts = stored.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('corrupt encrypted field');
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

const SECRET_KEYS = new Set(['clientSecret', 'apiSecret', 'apiKey', 'client_secret', 'api_secret', 'api_key']);

/** Encrypt secret-looking string fields inside a JSON blob (returns a copy). */
export function encryptSecrets<T>(obj: T, key: Buffer | undefined): T {
    if (obj == null || typeof obj !== 'object' || !key) return obj;
    const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
    for (const [k, v] of Object.entries(out)) {
        if (SECRET_KEYS.has(k) && typeof v === 'string' && v.length > 0 && !isEncrypted(v)) {
            out[k] = encryptField(v, key);
        }
    }
    return out as T;
}

/** Decrypt secret fields for display to an authorized caller. */
export function decryptSecrets<T>(obj: T, key: Buffer | undefined): T {
    if (obj == null || typeof obj !== 'object' || !key) return obj;
    const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
    for (const [k, v] of Object.entries(out)) {
        if (SECRET_KEYS.has(k) && isEncrypted(v)) {
            try {
                out[k] = decryptField(v, key);
            } catch {
                out[k] = null; // wrong key / corrupted row — don't leak ciphertext
            }
        }
    }
    return out as T;
}

/**
 * Masked view of a secret-bearing blob for admin display: decrypts at the
 * service boundary but never returns plaintext — each secret field becomes
 * '********' + last4 (empty stays empty). Non-secret fields pass through.
 */
export function maskSecrets<T>(obj: T, key: Buffer | undefined): T {
    const dec = decryptSecrets(obj, key);
    if (dec == null || typeof dec !== 'object') return dec;
    const out: Record<string, unknown> = { ...(dec as Record<string, unknown>) };
    for (const [k, v] of Object.entries(out)) {
        if (SECRET_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
            out[k] = `********${v.slice(-4)}`;
        }
    }
    return out as T;
}
