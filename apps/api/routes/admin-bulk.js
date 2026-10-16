const express = require('express');
const router = express.Router();
const { isHR, isStaff } = require('../middleware/auth');
const logger = require('../utils/logger');
const BulkOperation = require('../models/BulkOperation');
const db = require('../db');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');

// Bulk operations act on business entities (candidates, employees…) — creating
// them is an HR capability. The list endpoint is staff-readable (job metadata
// only: types, counts, status — no record content), so the Admin viewer keeps
// working while only HR can initiate operations.
// GET / — list recent bulk operations
router.get('/', isStaff, async (req, res) => {
    try {
        let limit = parseInt(req.query.limit, 10) || 50;
        if (limit > 200) limit = 200;

        const operations = await BulkOperation.find(limit);
        res.json(operations);
    } catch (err) {
        logger.error('Error listing bulk operations:', err);
        res.status(500).json({ error: 'Failed to list bulk operations' });
    }
});

// POST /import-candidates — create a bulk import job
router.post('/import-candidates', isHR, validate({ body: schemas.bulkImportBody }), async (req, res) => {
    try {
        const { total_records } = req.body;

        const job = await BulkOperation.create({
            operation_type: 'import',
            entity_type: 'candidates',
            total_records,
            initiated_by: req.user.id
        });
        res.json(job);
    } catch (err) {
        logger.error('Error creating bulk import job:', err);
        res.status(500).json({ error: 'Failed to create bulk import job' });
    }
});

// POST /export-candidates — create a bulk export job
router.post('/export-candidates', isHR, validate({ body: schemas.bulkExportBody }), async (req, res) => {
    try {
        const { columns } = req.body;

        const job = await BulkOperation.create({
            operation_type: 'export',
            entity_type: 'candidates',
            initiated_by: req.user.id
        });
        res.json(job);
    } catch (err) {
        logger.error('Error creating bulk export job:', err);
        res.status(500).json({ error: 'Failed to create bulk export job' });
    }
});

// POST /status-change — create a bulk status change job
router.post('/status-change', isHR, validate({ body: schemas.bulkStatusChangeBody }), async (req, res) => {
    try {
        const { candidate_ids, new_status } = req.body;

        const job = await BulkOperation.create({
            operation_type: 'status_change',
            entity_type: 'candidates',
            total_records: candidate_ids.length,
            initiated_by: req.user.id
        });
        res.json(job);
    } catch (err) {
        logger.error('Error creating bulk status change job:', err);
        res.status(500).json({ error: 'Failed to create bulk status change job' });
    }
});

// POST /archive — create a bulk archive job
router.post('/archive', isHR, validate({ body: schemas.bulkEntityIdsBody }), async (req, res) => {
    try {
        const { entity_type, ids } = req.body;

        const job = await BulkOperation.create({
            operation_type: 'archive',
            entity_type,
            total_records: ids.length,
            initiated_by: req.user.id
        });
        res.json(job);
    } catch (err) {
        logger.error('Error creating bulk archive job:', err);
        res.status(500).json({ error: 'Failed to create bulk archive job' });
    }
});

// POST /delete — create a bulk delete job
router.post('/delete', isHR, validate({ body: schemas.bulkEntityIdsBody }), async (req, res) => {
    try {
        const { entity_type, ids } = req.body;

        const job = await BulkOperation.create({
            operation_type: 'delete',
            entity_type,
            total_records: ids.length,
            initiated_by: req.user.id
        });
        res.json(job);
    } catch (err) {
        logger.error('Error creating bulk delete job:', err);
        res.status(500).json({ error: 'Failed to create bulk delete job' });
    }
});

module.exports = router;
