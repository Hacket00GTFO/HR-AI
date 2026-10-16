import { describe, expect, it } from 'vitest';
import { sanitizeFilename, sha256Hex, sniffMime, validateUploadBuffer } from '../src/fileValidation.js';
import { makeDocx, makePdf } from './helpers.js';

describe('magic-byte validation', () => {
    it('accepts a real PDF', () => {
        const { mime, ext } = validateUploadBuffer(makePdf('hello'), 'cv.pdf');
        expect(mime).toBe('application/pdf');
        expect(ext).toBe('.pdf');
    });

    it('accepts a real DOCX (zip container)', () => {
        const { mime } = validateUploadBuffer(makeDocx('hello'), 'cv.docx');
        expect(mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });

    it('rejects an executable renamed to .pdf', () => {
        const mz = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x90)]);
        expect(() => validateUploadBuffer(mz, 'cv.pdf')).toThrowError(expect.objectContaining({ status: 415 }));
    });

    it('rejects a legacy .doc (extension not allowed)', () => {
        const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        expect(() => validateUploadBuffer(ole, 'cv.doc')).toThrowError(expect.objectContaining({ status: 415 }));
    });

    it('rejects a .docx whose bytes are not a zip', () => {
        expect(() => validateUploadBuffer(Buffer.from('not a zip at all'), 'cv.docx')).toThrowError(
            expect.objectContaining({ status: 415 })
        );
    });

    it('rejects a truncated file', () => {
        expect(() => validateUploadBuffer(Buffer.from('%P'), 'cv.pdf')).toThrowError(
            expect.objectContaining({ status: 415 })
        );
    });

    it('sniffMime detects pdf/docx and rejects unknown', () => {
        expect(sniffMime(makePdf('x'))).toBe('application/pdf');
        expect(sniffMime(makeDocx('x'))).toBe(
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        expect(sniffMime(Buffer.from('MZ..'))).toBeNull();
    });
});

describe('sanitizeFilename', () => {
    it('strips path components', () => {
        expect(sanitizeFilename('../../etc/passwd.pdf', '.pdf')).toBe('passwd.pdf');
        expect(sanitizeFilename('C:\\temp\\cv.pdf', '.pdf')).toBe('cv.pdf');
    });

    it('replaces unsafe characters', () => {
        expect(sanitizeFilename('my résumé <final>.pdf', '.pdf')).toBe('my r_sum_ _final_.pdf');
    });

    it('forces the fallback extension when missing', () => {
        expect(sanitizeFilename('noext', '.pdf')).toBe('noext.pdf');
    });

    it('handles empty names', () => {
        expect(sanitizeFilename('', '.docx')).toBe('document.docx');
    });
});

describe('sha256Hex', () => {
    it('hashes deterministically', () => {
        const a = sha256Hex(Buffer.from('same'));
        const b = sha256Hex(Buffer.from('same'));
        expect(a).toBe(b);
        expect(a).toMatch(/^[a-f0-9]{64}$/);
    });
});
