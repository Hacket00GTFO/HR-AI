import { createHash } from 'node:crypto';
import path from 'node:path';
import { httpError } from '@strafor/node-common';

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx']);

const MAGIC_SIGNATURES: Record<string, Buffer> = {
    '.pdf': Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
    '.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04]) // PK\x03\x04 (ZIP container)
};

const EXT_TO_MIME: Record<string, string> = {
    '.pdf': PDF_MIME,
    '.docx': DOCX_MIME
};

/** Normalized extension for an allowed upload, or null when disallowed. */
export function safeExtension(filename: string | undefined | null): string | null {
    if (!filename) return null;
    const ext = path.extname(filename).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext) ? ext : null;
}

/** Sniff the real content type from magic bytes; null when unrecognized. */
export function sniffMime(buffer: Buffer): string | null {
    for (const [ext, signature] of Object.entries(MAGIC_SIGNATURES)) {
        if (buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature)) {
            return EXT_TO_MIME[ext] ?? null;
        }
    }
    return null;
}

/**
 * Validate an in-memory upload: extension must be allowlisted AND magic bytes
 * must agree with it. Throws an httpError(415) on mismatch — a renamed
 * executable or legacy .doc (OLE2, magic D0CF11E0) never reaches storage.
 */
export function validateUploadBuffer(buffer: Buffer, originalname: string | undefined): { ext: string; mime: string } {
    const ext = safeExtension(originalname);
    if (!ext) {
        throw httpError(415, 'Invalid file type. Only PDF and DOCX documents are allowed.');
    }
    const signature = MAGIC_SIGNATURES[ext];
    if (!signature || buffer.length < signature.length || !buffer.subarray(0, signature.length).equals(signature)) {
        throw httpError(415, 'File content does not match an allowed document type.');
    }
    return { ext, mime: EXT_TO_MIME[ext] as string };
}

// eslint-disable-next-line no-control-regex -- stripping control chars is the point
const CONTROL_CHARS = new RegExp('[\\x00-\\x1f\\x7f]', 'g');

/**
 * Strip path components and dangerous characters from a user filename.
 * Result is safe for S3 keys and Content-Disposition headers.
 */
export function sanitizeFilename(originalname: string | undefined, fallbackExt: string): string {
    const base = path.basename(originalname || `document${fallbackExt}`);
    const cleaned = base
        .replace(CONTROL_CHARS, '')
        .replace(/[^A-Za-z0-9._ -]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    const limited = cleaned.slice(0, 200) || `document${fallbackExt}`;
    return limited.toLowerCase().endsWith(fallbackExt) ? limited : `${limited}${fallbackExt}`;
}

export function sha256Hex(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}
