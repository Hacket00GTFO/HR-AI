import path from 'node:path';
import { httpError } from '@strafor/node-common';

// Resume file validation helpers — buffer-level port of the monolith's
// utils/fileValidation.js + documents-resumes' src/fileValidation.ts.
// Validates by extension AND magic bytes (content sniffing) so a renamed
// executable/macro document cannot pass as a CV.

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// NOTE: legacy .doc (OLE2 compound files) is intentionally NOT allowed — macro risk.
export const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx']);

const MAGIC_SIGNATURES: Record<string, Buffer> = {
    '.pdf': Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
    '.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04]) // PK\x03\x04 (ZIP container)
};

const EXT_TO_MIME: Record<string, string> = {
    '.pdf': PDF_MIME,
    '.docx': DOCX_MIME
};

/** True when the extension of `filenameOrExt` is allowlisted. */
export function isAllowedExtension(filenameOrExt: string): boolean {
    const ext = filenameOrExt.startsWith('.') ? filenameOrExt.toLowerCase() : path.extname(filenameOrExt).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
}

/** Normalized, forced-safe extension for an allowed upload, or null. */
export function safeExtension(filenameOrExt: string | undefined | null): string | null {
    if (!filenameOrExt) return null;
    const ext = filenameOrExt.startsWith('.') ? filenameOrExt.toLowerCase() : path.extname(filenameOrExt).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext) ? ext : null;
}

/** Magic bytes of an in-memory buffer must match the claimed extension. */
export function bufferHasValidMagicBytes(buffer: Buffer, ext: string): boolean {
    const signature = MAGIC_SIGNATURES[ext];
    if (!signature) return false;
    return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

/**
 * Validate an in-memory upload: extension must be allowlisted AND magic bytes
 * must agree with it. Throws httpError(415) on mismatch — a renamed
 * executable or legacy .doc (OLE2, magic D0CF11E0) never reaches storage.
 */
export function validateUploadBuffer(buffer: Buffer, originalname: string | undefined): { ext: string; mime: string } {
    const ext = safeExtension(originalname);
    if (!ext) {
        throw httpError(415, 'Invalid file type. Only PDF and DOCX documents are allowed.');
    }
    if (!bufferHasValidMagicBytes(buffer, ext)) {
        throw httpError(415, 'File content does not match an allowed document type.');
    }
    return { ext, mime: EXT_TO_MIME[ext] as string };
}
