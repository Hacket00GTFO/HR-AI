const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');
const { callIdentity, legacyError, legacyUser } = require('../utils/serviceClient');

// ── Strangler proxy ─────────────────────────────────────────────────────────
// HR account management moved to identity-auth (/v1/users). Same shape as
// before: array on list, {message} errors, 'HR account …' wording.

// Get all HR accounts
router.get('/', isAdmin, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: '/v1/users?role=hr&limit=500'
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error fetching HR accounts'));
        }
        res.json((data.data || []).map(legacyUser));
    } catch (error) {
        logger.error('Error fetching HR accounts:', error);
        res.status(500).json({ message: 'Error fetching HR accounts' });
    }
});

// Create new HR account
router.post('/', isAdmin, validate({ body: schemas.accountCreateBody }), async (req, res) => {
    try {
        const { firstName, lastName, email, password, location } = req.body;
        const { status, data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/users',
            body: { firstName, lastName, email, password, role: 'hr', location }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error creating HR account'));
        }
        res.status(201).json(legacyUser(data));
    } catch (error) {
        logger.error('Error creating HR account:', error);
        res.status(500).json({ message: 'Error creating HR account' });
    }
});

// Delete HR account
router.delete('/:id', isAdmin, async (req, res) => {
    try {
        const existing = await callIdentity(req, { method: 'GET', path: `/v1/users/${req.params.id}` });
        if (existing.status >= 400 || !existing.data || existing.data.role !== 'hr') {
            return res
                .status(existing.status === 502 ? 502 : 404)
                .json(existing.status === 502 ? legacyError(existing.data) : { message: 'HR account not found' });
        }

        const { status, data } = await callIdentity(req, {
            method: 'DELETE',
            path: `/v1/users/${req.params.id}`
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error deleting HR account'));
        }
        res.json({ message: 'HR account deleted successfully' });
    } catch (error) {
        logger.error('Error deleting HR account:', error);
        res.status(500).json({ message: 'Error deleting HR account' });
    }
});

// Get HR account by ID
router.get('/:id', isAdmin, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: `/v1/users/${req.params.id}`
        });
        if (status >= 400 || !data || data.role !== 'hr') {
            return res
                .status(status === 502 ? 502 : 404)
                .json(status === 502 ? legacyError(data) : { message: 'HR account not found' });
        }
        res.json(legacyUser(data));
    } catch (error) {
        logger.error('Error fetching HR account:', error);
        res.status(500).json({ message: 'Error fetching HR account' });
    }
});

// Update HR account
router.put('/:id', isAdmin, validate({ body: schemas.accountUpdateBody }), async (req, res) => {
    try {
        const { firstName, lastName, email, password, location } = req.body;

        const existing = await callIdentity(req, { method: 'GET', path: `/v1/users/${req.params.id}` });
        if (existing.status >= 400 || !existing.data || existing.data.role !== 'hr') {
            return res
                .status(existing.status === 502 ? 502 : 404)
                .json(existing.status === 502 ? legacyError(existing.data) : { message: 'HR account not found' });
        }

        const updateData = { firstName, lastName, email, location };
        if (password) updateData.password = password;

        const { status, data } = await callIdentity(req, {
            method: 'PUT',
            path: `/v1/users/${req.params.id}`,
            body: updateData
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error updating HR account'));
        }
        res.json(legacyUser(data));
    } catch (error) {
        logger.error('Error updating HR account:', error);
        res.status(500).json({ message: 'Error updating HR account' });
    }
});

module.exports = router;
