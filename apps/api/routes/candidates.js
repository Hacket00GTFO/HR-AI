const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const Candidate = require('../models/Candidate');
const Application = require('../models/Application');
const audit = require('../utils/audit');
const logger = require('../utils/logger');
const { isHR } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');
const { isAllowedExtension, safeExtension, hasValidMagicBytes } = require('../utils/fileValidation');

// Resumes live OUTSIDE the static web root — they are only served through the
// authenticated GET /:id/resume endpoint below.
// Repo root is three levels up from apps/api/routes. Override with RESUMES_DIR.
const RESUMES_DIR = process.env.RESUMES_DIR || path.join(__dirname, '..', '..', '..', 'secure_uploads', 'resumes');

// Configure multer for file uploads
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

// POST /api/candidates/upload — resume upload (HR only)
router.post('/upload', isHR, uploadResume, (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        if (!validateStoredUpload(req, res)) return;
        res.json({
            path: req.file.filename,
            message: 'Resume uploaded successfully'
        });
    } catch (error) {
        logger.error('Error uploading resume:', error);
        res.status(500).json({ error: 'Error uploading resume' });
    }
});

// GET /api/candidates — one row per application, vacancy title populated (HR only).
// Filters: ?status= & vacancy_id=/applied_for= map onto Application filters;
// ?q= is a case-insensitive substring match across name, email and skills;
// ?orderBy= / ?limit= are whitelisted inside the model (never interpolated).
router.get('/', isHR, validate({ query: schemas.candidateListQuery }), async (req, res) => {
    try {
        const { status, vacancy_id, applied_for, q, orderBy, limit } = req.query;

        const candidates = await Application.findWithVacancyTitle(
            { status, vacancy_id: vacancy_id ?? applied_for },
            { orderBy }
        );

        // `q` runs in memory — the HR data set is bounded and the model owns
        // the SQL. Same fields the legacy UI searched (name + skills) plus email.
        const needle = q ? q.toLowerCase() : null;
        const matched = needle
            ? candidates.filter((c) =>
                  `${c.first_name ?? ''} ${c.last_name ?? ''} ${c.email ?? ''} ${c.skills ?? ''}`
                      .toLowerCase()
                      .includes(needle)
              )
            : candidates;

        const capped = limit ? matched.slice(0, limit) : matched;

        const formattedCandidates = capped.map((candidate) => ({
            ...candidate,
            applied_at: candidate.applied_at ? new Date(candidate.applied_at).toISOString() : new Date().toISOString()
        }));

        logger.debug(`Successfully fetched ${formattedCandidates.length} candidates`);
        res.json(formattedCandidates);
    } catch (err) {
        logger.error('Error fetching all candidates:', err);
        res.status(500).json({ error: 'Error fetching candidates' });
    }
});

// GET /api/candidates/:id/resume — authenticated resume download (HR only).
// Path-traversal safe: only the basename is used and the resolved path must
// stay inside RESUMES_DIR.
router.get('/:id/resume', isHR, validate({ params: schemas.idParam }), async (req, res) => {
    try {
        const candidate = await Candidate.findById(req.params.id);
        if (!candidate || !candidate.resume) {
            return res.status(404).json({ error: 'Resume not found' });
        }

        const safeName = path.basename(candidate.resume);
        const resolvedDir = path.resolve(RESUMES_DIR);
        const filePath = path.resolve(resolvedDir, safeName);
        if (!filePath.startsWith(resolvedDir + path.sep)) {
            return res.status(400).json({ error: 'Invalid resume path' });
        }

        res.sendFile(filePath, (err) => {
            if (err && !res.headersSent) {
                res.status(404).json({ error: 'Resume not found' });
            }
        });
    } catch (err) {
        logger.error('Error fetching resume:', err);
        res.status(500).json({ error: 'Error fetching resume' });
    }
});

// GET /api/candidates/:id/history — status timeline for the candidate's
// application (HR only). History is per-application: ?vacancy_id= (or the
// legacy applied_for) picks which one when the candidate applied to more than
// one vacancy; defaults to the most recent application.
router.get(
    '/:id/history',
    isHR,
    validate({ params: schemas.idParam, query: schemas.candidateHistoryQuery }),
    async (req, res) => {
        try {
            const vacancyId = req.query.vacancy_id ?? req.query.applied_for;
            const application = await Application.resolveForCandidate(req.params.id, vacancyId);
            if (!application) {
                return res.status(404).json({ error: 'Candidate or application not found' });
            }
            const history = await Application.history(application.id);
            res.json(history);
        } catch (err) {
            logger.error('Error fetching candidate history:', err);
            res.status(500).json({ error: 'Error fetching candidate history' });
        }
    }
);

// POST /api/candidates — create candidate (with optional resume file) (HR only)
router.post('/', isHR, uploadResume, validate({ body: schemas.candidateCreateBody }), async (req, res) => {
    try {
        if (req.file && !validateStoredUpload(req, res)) return;

        const candidateData = {
            ...req.body,
            applied_at: req.body.applied_at ? new Date(req.body.applied_at) : new Date()
        };
        if (req.file) {
            candidateData.resume = req.file.filename;
        }

        // Single tx: candidate (upsert on unique email) + application +
        // initial status-history row + skills links.
        const response = await Candidate.createWithVacancy(candidateData, { createdBy: req.user.id });

        await audit.record({
            actorId: req.user.id,
            action: 'application.create',
            entity: 'applications',
            entityId: response.application_id,
            metadata: { candidate_id: response.id, vacancy_id: req.body.applied_for }
        });

        // No PII in logs — ids only (name/email stay out of the log stream).
        logger.debug(`Successfully created candidate id=${response.id} application=${response.application_id}`);
        res.status(201).json(response);
    } catch (err) {
        logger.error('Error creating candidate:', err);
        res.status(err.status || 500).json({ error: 'Error creating candidate' });
    }
});

// PUT /api/candidates/:id/status (HR only)
// Status lives on the application now: body may carry vacancy_id (or the
// legacy applied_for) to pick which application; defaults to the latest one.
router.put(
    '/:id/status',
    isHR,
    validate({ params: schemas.idParam, body: schemas.candidateStatusBody }),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;
            const vacancyId = req.body.vacancy_id ?? req.body.applied_for;

            const result = await db.withTransaction(async (client) => {
                const application = await Application.resolveForCandidate(id, vacancyId, client);
                if (!application) return null;
                return Application.updateStatus(application.id, status, {
                    changedBy: req.user.id,
                    client
                });
            });

            if (!result) {
                return res.status(404).json({ error: 'Candidate or application not found' });
            }

            await audit.record({
                actorId: req.user.id,
                action: 'application.status_change',
                entity: 'applications',
                entityId: result.application_id,
                metadata: { candidate_id: Number(id), to_status: status }
            });

            logger.debug(`Successfully updated status for candidate ${id} to ${status}`);
            res.json(result);
        } catch (err) {
            logger.error('Error updating candidate status:', err);
            res.status(err.status || 500).json({ error: 'Error updating candidate status' });
        }
    }
);

// PUT /api/candidates/:id/feedback (HR only)
router.put(
    '/:id/feedback',
    isHR,
    validate({ params: schemas.idParam, body: schemas.candidateFeedbackBody }),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { hiring_feedback, ai_insights } = req.body;
            const vacancyId = req.body.vacancy_id ?? req.body.applied_for;

            const application = await Application.resolveForCandidate(id, vacancyId);
            if (!application) {
                return res.status(404).json({ error: 'Candidate or application not found' });
            }

            if (application.status !== 'accepted') {
                return res.status(400).json({ error: 'Feedback can only be provided for accepted candidates' });
            }

            await Application.updateById(application.id, {
                hiring_feedback,
                ai_insights,
                feedback_timestamp: new Date()
            });

            const updatedCandidate = await Application.legacyRow(application.id);

            logger.debug(`Successfully updated hiring feedback for candidate ${id}`);
            res.json(updatedCandidate);
        } catch (err) {
            logger.error('Error updating candidate hiring feedback:', err);
            res.status(err.status || 500).json({ error: 'Error updating candidate hiring feedback' });
        }
    }
);

module.exports = router;
