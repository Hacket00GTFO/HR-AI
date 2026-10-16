const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');
const { callIdentity, legacyError, legacyUser } = require('../utils/serviceClient');

// ── Strangler proxy ─────────────────────────────────────────────────────────
// User profile reads/writes moved to identity-auth (/v1/users/:id). These
// routes forward the caller's bearer token; identity enforces self-or-admin.

// Get user profile
router.get('/profile', verifyToken, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: `/v1/users/${req.user.id}`
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error fetching user profile'));
        }
        res.json(legacyUser(data));
    } catch (error) {
        logger.error('Error fetching user profile:', error);
        res.status(500).json({ message: 'Error fetching user profile' });
    }
});

// Update user profile
router.put('/profile', verifyToken, validate({ body: schemas.profileUpdateBody }), async (req, res) => {
    try {
        const { firstName, lastName, location } = req.body;
        const { status, data } = await callIdentity(req, {
            method: 'PUT',
            path: `/v1/users/${req.user.id}`,
            body: { firstName, lastName, location }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error updating user profile'));
        }
        res.json(legacyUser(data));
    } catch (error) {
        logger.error('Error updating user profile:', error);
        res.status(500).json({ message: 'Error updating user profile' });
    }
});

module.exports = router;
