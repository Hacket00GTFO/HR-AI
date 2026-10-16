// Upload hardening tests: extension allowlist + magic-byte validation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
    isAllowedExtension,
    safeExtension,
    hasValidMagicBytes,
    isValidResumeFile
} = require('../utils/fileValidation');

let tmpDir;
const files = {};

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafor-upload-test-'));
    files.validPdf = path.join(tmpDir, 'cv.pdf');
    files.validDocx = path.join(tmpDir, 'cv.docx');
    files.fakePdf = path.join(tmpDir, 'evil.pdf');      // .pdf name, EXE content
    files.exe = path.join(tmpDir, 'evil.exe');
    files.doc = path.join(tmpDir, 'macro.doc');         // legacy OLE2 .doc — banned
    files.empty = path.join(tmpDir, 'empty.pdf');

    fs.writeFileSync(files.validPdf, Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(64)]));
    fs.writeFileSync(files.validDocx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]));
    fs.writeFileSync(files.fakePdf, Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)])); // MZ
    fs.writeFileSync(files.exe, Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]));
    fs.writeFileSync(files.doc, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(64)])); // OLE2
    fs.writeFileSync(files.empty, Buffer.alloc(0));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
    });
});

describe('magic-byte validation', () => {
    it('accepts real PDF and DOCX signatures', () => {
        expect(hasValidMagicBytes(files.validPdf, '.pdf')).toBe(true);
        expect(hasValidMagicBytes(files.validDocx, '.docx')).toBe(true);
    });

    it('rejects content that does not match the claimed type', () => {
        expect(hasValidMagicBytes(files.fakePdf, '.pdf')).toBe(false);
        expect(hasValidMagicBytes(files.exe, '.pdf')).toBe(false);
        expect(hasValidMagicBytes(files.exe, '.docx')).toBe(false);
        expect(hasValidMagicBytes(files.empty, '.pdf')).toBe(false);
        expect(hasValidMagicBytes(path.join(tmpDir, 'missing.pdf'), '.pdf')).toBe(false);
    });

    it('isValidResumeFile combines extension + magic bytes', () => {
        expect(isValidResumeFile(files.validPdf, 'cv.pdf')).toBe(true);
        expect(isValidResumeFile(files.validDocx, 'cv.docx')).toBe(true);
        expect(isValidResumeFile(files.fakePdf, 'evil.pdf')).toBe(false); // renamed EXE
        expect(isValidResumeFile(files.doc, 'macro.doc')).toBe(false);    // .doc banned outright
        expect(isValidResumeFile(files.exe, 'evil.exe')).toBe(false);
    });
});
