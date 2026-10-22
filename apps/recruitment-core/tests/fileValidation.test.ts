// Upload hardening tests — buffer-level port of the monolith's
// tests/upload.test.js (utils/fileValidation.js) for the in-memory flow.
import { describe, it, expect } from 'vitest';
import {
    isAllowedExtension,
    safeExtension,
    bufferHasValidMagicBytes,
    validateUploadBuffer
} from '../src/fileValidation.js';
import { VALID_PDF, VALID_DOCX, FAKE_PDF } from './helpers.js';

const OLE2_DOC = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(64)]); // legacy .doc
const EMPTY = Buffer.alloc(0);

describe('extension allowlist', () => {
    it('accepts .pdf and .docx', () => {
        expect(isAllowedExtension('cv.pdf')).toBe(true);
        expect(isAllowedExtension('cv.DOCX')).toBe(true);
    });

    it('rejects .doc (macro risk), .exe, double extensions and no extension', () => {
        expect(isAllowedExtension('macro.doc')).toBe(false);
        expect(isAllowedExtension('evil.exe')).toBe(false);
        expect(isAllowedExtension('evil.pdf.exe')).toBe(false);
        expect(isAllowedExtension('noext')).toBe(false);
    });

    it('safeExtension returns a forced-safe ext or null', () => {
        expect(safeExtension('CV.PDF')).toBe('.pdf');
        expect(safeExtension('cv.docx')).toBe('.docx');
        expect(safeExtension('../../etc/passwd.doc')).toBeNull();
        expect(safeExtension(undefined)).toBeNull();
    });
});

describe('magic-byte validation', () => {
    it('accepts real PDF and DOCX signatures', () => {
        expect(bufferHasValidMagicBytes(VALID_PDF, '.pdf')).toBe(true);
        expect(bufferHasValidMagicBytes(VALID_DOCX, '.docx')).toBe(true);
    });

    it('rejects content that does not match the claimed type', () => {
        expect(bufferHasValidMagicBytes(FAKE_PDF, '.pdf')).toBe(false);
        expect(bufferHasValidMagicBytes(OLE2_DOC, '.pdf')).toBe(false);
        expect(bufferHasValidMagicBytes(EMPTY, '.pdf')).toBe(false);
    });
});

describe('validateUploadBuffer', () => {
    it('returns ext + mime for valid uploads', () => {
        expect(validateUploadBuffer(VALID_PDF, 'cv.pdf')).toEqual({
            ext: '.pdf',
            mime: 'application/pdf'
        });
        expect(validateUploadBuffer(VALID_DOCX, 'cv.docx').ext).toBe('.docx');
    });

    it('throws 415 for a renamed executable', () => {
        expect(() => validateUploadBuffer(FAKE_PDF, 'evil.pdf')).toThrowError(expect.objectContaining({ status: 415 }));
    });

    it('throws 415 for banned/absent extensions regardless of content', () => {
        for (const name of ['macro.doc', 'evil.exe', 'noext']) {
            expect(() => validateUploadBuffer(VALID_PDF, name)).toThrowError(expect.objectContaining({ status: 415 }));
        }
    });

    it('throws 415 for an OLE2 .doc masquerading as .docx', () => {
        expect(() => validateUploadBuffer(OLE2_DOC, 'cv.docx')).toThrowError(expect.objectContaining({ status: 415 }));
    });
});
