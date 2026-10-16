const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const Candidate = require('../models/Candidate');
const Vacancy = require('../models/Vacancy');
const audit = require('../utils/audit');
const logger = require('../utils/logger');
const schemas = require('../middleware/schemas');
const { isAllowedExtension, safeExtension, hasValidMagicBytes } = require('../utils/fileValidation');

// Public, unauthenticated endpoints — currently only the careers "apply" flow
// used by the new apps/web frontend (POST /api/public/apply). Everything here
// must stay PII-minimal and is rate-limited harder than the global API limiter.

// Same storage policy as routes/candidates.js: resumes live OUTSIDE the static
// web root and are only reachable through the authenticated resume endpoint.
// Repo root is three levels up from apps/api/routes. Override with RESUMES_DIR.
const RESUMES_DIR = process.env.RESUMES_DIR || path.join(__dirname, '..', '..', '..', 'secure_uploads', 'resumes');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, RESUMES_DIR);
    },
    filename: function (req, file, cb) {
        // Server-generated name only: no user-controlled path characters,
        // extension forced to a safe allowlisted value.
        const ext = safeExtension(file.originalname) || '.bin';
        const unique = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
        cb(null, `resume_${unique}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (isAllowedExtension(file.originalname)) {
            cb(null, true);
        } else {
            const err = new Error('Invalid file type. Only PDF and DOCX documents are allowed.');
            err.status = 415;
            cb(err);
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
        files: 1
    }
});

// Wrap multer so upload errors map to clean HTTP statuses instead of 500s.
function uploadResume(req, res, next) {
    upload.single('resume')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return res.status(status).json({ error: `Upload rejected: ${err.message}` });
        }
        return res.status(err.status || 400).json({ error: err.message });
    });
}

// Post-storage validation: magic bytes must match the claimed type, then
// tighten file permissions. Deletes the file and returns false on failure.
function validateStoredUpload(req, res) {
    if (!req.file) return true;
    const ext = safeExtension(req.file.originalname);
    if (!ext || !hasValidMagicBytes(req.file.path, ext)) {
        try {
            fs.unlinkSync(req.file.path);
        } catch {
            /* ignore */
        }
        res.status(415).json({ error: 'File content does not match an allowed document type.' });
        return false;
    }
    try {
        fs.chmodSync(req.file.path, 0o600);
    } catch {
        /* best effort */
    }
    return true;
}

// Remove a stored resume when the rest of the request fails — a rejected
// application must not leave orphaned PII files on disk.
function cleanupStoredUpload(req) {
    if (!req.file) return;
    try {
        fs.unlinkSync(req.file.path);
    } catch {
        /* ignore */
    }
}

// Same error shape as middleware/validate.js, but with upload cleanup — multer
// stores the resume BEFORE the body is parsed, so a failed validation must not
// orphan the file on disk.
function validateApplyBody(req, res) {
    const result = schemas.publicApplyBody.safeParse(req.body);
    if (result.success) {
        req.body = result.data;
        return true;
    }
    cleanupStoredUpload(req);
    res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message
        }))
    });
    return false;
}

// Dedicated limiter for the anonymous apply endpoint — much stricter than the
// global API limiter (20 submissions/hour/IP vs 600/15min globally).
const applyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many applications submitted, please try again later.' }
});

// POST /api/public/apply — anonymous job application.
// multipart/form-data: candidate fields + optional `resume` (pdf/docx, <=5MB).
// 201 { application_id, message } on success; 200 { message } when the
// candidate already applied to this vacancy (partial unique index on
// applications(candidate_id, vacancy_id) WHERE deleted_at IS NULL).
router.post('/apply', applyLimiter, uploadResume, async (req, res) => {
    try {
        if (!validateApplyBody(req, res)) return;
        if (req.file && !validateStoredUpload(req, res)) return;

        // Friendly 404 instead of a raw FK violation for dead vacancy ids.
        const vacancy = await Vacancy.findById(req.body.applied_for);
        if (!vacancy) {
            cleanupStoredUpload(req);
            return res.status(404).json({ error: 'Vacancy not found' });
        }

        const candidateData = {
            ...req.body,
            applied_at: new Date()
        };
        if (req.file) {
            candidateData.resume = req.file.filename;
        }

        // Single tx: candidate (upsert on unique email) + application +
        // initial status-history row + skills links. No actor — public flow.
        const response = await Candidate.createWithVacancy(candidateData, { createdBy: null });

        await audit.record({
            actorId: null,
            action: 'application.create',
            entity: 'applications',
            entityId: response.application_id,
            metadata: { candidate_id: response.id, vacancy_id: req.body.applied_for, source: 'public' }
        });

        logger.debug(
            `Public application received: application ${response.application_id} for vacancy ${req.body.applied_for}`
        );
        res.status(201).json({
            application_id: response.application_id,
            message: 'Application received'
        });
    } catch (err) {
        cleanupStoredUpload(req);
        // One live application per (candidate, vacancy) — the partial unique
        // index fires on re-application; answer idempotently with 200.
        if (err && err.code === '23505') {
            return res.status(200).json({ message: 'Application already received' });
        }
        if (err && err.code === '23503') {
            return res.status(404).json({ error: 'Vacancy not found' });
        }
        logger.error('Error processing public application:', err);
        res.status(err.status || 500).json({ error: 'Error submitting application' });
    }
});

module.exports = router;
