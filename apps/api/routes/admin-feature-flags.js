const express = require('express');
const router = express.Router();
const { isAdmin, verifyToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const db = require('../db');
const FeatureFlag = require('../models/FeatureFlag');

// GET /public (verifyToken — NOT isAdmin) — returns flags visible to the
// authenticated user: { key: enabled } map. Only returns enabled flags and
// their rollout status for the user. Declared before the isAdmin routes so
// /public is not shadowed by /:key.
router.get('/public', verifyToken, async (req, res) => {
    try {
        const flags = await FeatureFlag.find();
        const result = {};
        for (const flag of flags || []) {
            if (flag.enabled) {
                result[flag.key] = true;
            }
        }
        res.json(result);
    } catch (err) {
        logger.error('Failed to fetch public feature flags:', err);
        res.status(500).json({ error: 'Failed to fetch feature flags' });
    }
});

// GET / (isAdmin) — list all feature flags
router.get('/', isAdmin, async (req, res) => {
    try {
        const flags = await FeatureFlag.find();
        res.json(flags);
    } catch (err) {
        logger.error('Failed to list feature flags:', err);
        res.status(500).json({ error: 'Failed to list feature flags' });
    }
});

// POST / (isAdmin) — create flag. Body: { key, description, enabled, rollout_percentage }
router.post('/', isAdmin, async (req, res) => {
    try {
        const { key, description, enabled, rollout_percentage } = req.body;
        const flag = await FeatureFlag.create({
            key,
            description,
            enabled,
            rollout_percentage
        });
        res.status(201).json(flag);
    } catch (err) {
        logger.error('Failed to create feature flag:', err);
        res.status(500).json({ error: 'Failed to create feature flag' });
    }
});

// PUT /:key (isAdmin) — update flag. Body: { enabled, rollout_percentage, description }
// Pass req.user.id as userId.
router.put('/:key', isAdmin, async (req, res) => {
    try {
        const { enabled, rollout_percentage, description } = req.body;
        const flag = await FeatureFlag.update(
            req.params.key,
            {
                enabled,
                rollout_percentage,
                description
            },
            req.user.id
        );
        if (!flag) {
            return res.status(404).json({ error: 'Feature flag not found' });
        }
        res.json(flag);
    } catch (err) {
        logger.error('Failed to update feature flag:', err);
        res.status(500).json({ error: 'Failed to update feature flag' });
    }
});

module.exports = router;
