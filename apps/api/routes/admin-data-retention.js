const express = require('express');
const router = express.Router();
const fs = require('fs');
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const DataRetention = require('../models/DataRetention');
const dsarExecutor = require('../utils/dsar');
const audit = require('../utils/audit');
const db = require('../db');

// @route   GET /policies
// @desc    List all retention policies
// @access  Admin
router.get('/policies', isAdmin, async (req, res) => {
    try {
        const policies = await DataRetention.findPolicies();
        res.json(policies);
    } catch (err) {
        logger.error('Error fetching retention policies:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /policies
// @desc    Create a retention policy
// @access  Admin
router.post('/policies', isAdmin, async (req, res) => {
    try {
        const { entity_type, retention_days, action, active } = req.body;
        const policy = await DataRetention.createPolicy({
            entity_type,
            retention_days,
            action,
            active
        });
        res.status(201).json(policy);
    } catch (err) {
        logger.error('Error creating retention policy:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   PUT /policies/:id
// @desc    Update a retention policy
// @access  Admin
router.put('/policies/:id', isAdmin, async (req, res) => {
    try {
        const { entity_type, retention_days, action, active } = req.body;
        const policy = await DataRetention.updatePolicy(req.params.id, {
            entity_type,
            retention_days,
            action,
            active
        });
        if (!policy) {
            return res.status(404).json({ message: 'Policy not found' });
        }
        res.json(policy);
    } catch (err) {
        logger.error('Error updating retention policy:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   DELETE /policies/:id
// @desc    Delete a retention policy
// @access  Admin
router.delete('/policies/:id', isAdmin, async (req, res) => {
    try {
        const deleted = await DataRetention.deletePolicy(req.params.id);
        if (!deleted) {
            return res.status(404).json({ message: 'Policy not found' });
        }
        res.json({ message: 'deleted' });
    } catch (err) {
        logger.error('Error deleting retention policy:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   GET /dsar
// @desc    List all DSARs
// @access  Admin
router.get('/dsar', isAdmin, async (req, res) => {
    try {
        const dsars = await DataRetention.findDsars();
        res.json(dsars);
    } catch (err) {
        logger.error('Error fetching DSARs:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /dsar
// @desc    Create a DSAR
// @access  Admin
router.post('/dsar', isAdmin, async (req, res) => {
    try {
        const { type, email, candidate_id, requested_by } = req.body;
        const dsar = await DataRetention.createDsar({
            type,
            email,
            candidate_id,
            requested_by
        });
        res.status(201).json(dsar);
    } catch (err) {
        logger.error('Error creating DSAR:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /dsar/:id/execute
// @desc    Execute a DSAR — runs the real access export or erasure.
// @access  Admin
router.post('/dsar/:id/execute', isAdmin, async (req, res) => {
    try {
        const existing = await DataRetention.findDsarById(req.params.id);
        if (!existing) {
            return res.status(404).json({ message: 'DSAR not found' });
        }
        if (existing.status !== 'pending') {
            return res.status(400).json({ message: 'DSAR is not pending' });
        }

        await DataRetention.updateDsarStatus(req.params.id, 'processing');
        try {
            const { resultUrl, detail } = await dsarExecutor.execute(existing);
            await db.query(
                'UPDATE data_subject_requests SET status = $2, result_url = $3, completed_at = now() WHERE id = $1',
                [req.params.id, 'completed', resultUrl]
            );
            await audit.record({
                actorId: req.user.id,
                action: `dsar.${existing.type}`,
                entity: 'data_subject_requests',
                entityId: req.params.id,
                metadata: { detail }
            });
        } catch (execErr) {
            await db.query('UPDATE data_subject_requests SET status = $2 WHERE id = $1', [req.params.id, 'failed']);
            await audit.record({
                actorId: req.user.id,
                action: 'dsar.failed',
                entity: 'data_subject_requests',
                entityId: req.params.id,
                metadata: { error: execErr.message }
            });
            if (execErr.code === 'not_found') {
                return res.status(404).json({ message: execErr.message });
            }
            throw execErr;
        }

        const dsar = await DataRetention.findDsarById(req.params.id);
        res.json(dsar);
    } catch (err) {
        logger.error('Error executing DSAR:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   GET /dsar/:id/download
// @desc    Download the generated access export
// @access  Admin
router.get('/dsar/:id/download', isAdmin, async (req, res) => {
    try {
        const dsar = await DataRetention.findDsarById(req.params.id);
        if (!dsar || dsar.status !== 'completed' || dsar.type !== 'access') {
            return res.status(404).json({ message: 'Export not available' });
        }
        const filePath = dsarExecutor.exportPath(dsar.id);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'Export file missing' });
        }
        return res.download(filePath, `dsar-${dsar.id}.json`);
    } catch (err) {
        logger.error('Error downloading DSAR export:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
