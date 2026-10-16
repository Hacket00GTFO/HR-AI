// Resume file validation helpers — no external dependencies.
// Validates by extension AND magic bytes (content sniffing) so a renamed
// executable/macro document cannot pass as a CV.

const fs = require('fs');
const path = require('path');

// NOTE: legacy .doc (OLE2 compound files) is intentionally NOT allowed — macro risk.
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx']);

const MAGIC_SIGNATURES = {
    '.pdf': [Buffer.from([0x25, 0x50, 0x44, 0x46])],           // %PDF
    '.docx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])]           // PK\x03\x04 (ZIP container)
};

/**
 * Returns true if the extension is allowed for resume upload.
 * @param {string} filenameOrExt original filename or extension
 */
function isAllowedExtension(filenameOrExt) {
    const ext = filenameOrExt.startsWith('.')
        ? filenameOrExt.toLowerCase()
        : path.extname(filenameOrExt).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Normalized, forced-safe extension for an allowed upload, or null if disallowed.
 */
function safeExtension(filenameOrExt) {
    const ext = filenameOrExt.startsWith('.')
        ? filenameOrExt.toLowerCase()
        : path.extname(filenameOrExt).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext) ? ext : null;
}

/**
 * Read the first bytes of a file and check them against the magic signature
 * for the given extension.
 * @param {string} filePath absolute path to the stored file
 * @param {string} ext normalized extension ('.pdf' | '.docx')
 * @returns {boolean}
 */
function hasValidMagicBytes(filePath, ext) {
    const signatures = MAGIC_SIGNATURES[ext];
    if (!signatures) return false;

    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(8);
        const bytesRead = fs.readSync(fd, header, 0, 8, 0);
        if (bytesRead < 4) return false;
        return signatures.some(sig => header.subarray(0, sig.length).equals(sig));
    } catch {
        return false;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }
}

/**
 * Full validation for a stored upload: extension + magic bytes must agree.
 * @returns {boolean}
 */
function isValidResumeFile(filePath, originalname) {
    const ext = safeExtension(originalname || filePath);
    if (!ext) return false;
    return hasValidMagicBytes(filePath, ext);
}

module.exports = {
    ALLOWED_EXTENSIONS,
    isAllowedExtension,
    safeExtension,
    hasValidMagicBytes,
    isValidResumeFile
};
