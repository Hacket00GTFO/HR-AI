const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');
const { callIdentity, legacyError, legacyUser } = require('../utils/serviceClient');

// ── Strangler proxy ─────────────────────────────────────────────────────────
// Account management moved to identity-auth (/v1/users). These routes keep the
// legacy surface: plain arrays on list, {message} errors, 'Admin account …'
// wording. Identity still enforces admin role + uniqueness.

// Get all admin accounts
router.get('/', isAdmin, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: '/v1/users?role=admin&limit=500'
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error fetching admin accounts'));
        }
        res.json((data.data || []).map(legacyUser));
    } catch (error) {
        logger.error('Error fetching admin accounts:', error);
        res.status(500).json({ message: 'Error fetching admin accounts' });
    }
});

// Create new admin account
router.post('/', isAdmin, validate({ body: schemas.accountCreateBody }), async (req, res) => {
    try {
        const { firstName, lastName, email, password, location } = req.body;
        const { status, data } = await callIdentity(req, {
            method: 'POST',
            path: '/v1/users',
            body: { firstName, lastName, email, password, role: 'admin', location }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error creating admin account'));
        }
        res.status(201).json(legacyUser(data));
    } catch (error) {
        logger.error('Error creating admin account:', error);
        res.status(500).json({ message: 'Error creating admin account' });
    }
});

// Update admin account
router.put('/:id', isAdmin, validate({ body: schemas.accountUpdateBody }), async (req, res) => {
    try {
        const { firstName, lastName, email, password, location } = req.body;

        // Check the target exists and is an admin (preserves the 404 wording).
        const existing = await callIdentity(req, { method: 'GET', path: `/v1/users/${req.params.id}` });
        if (existing.status >= 400 || !existing.data || existing.data.role !== 'admin') {
            return res
                .status(existing.status === 502 ? 502 : 404)
                .json(existing.status === 502 ? legacyError(existing.data) : { message: 'Admin account not found' });
        }

        const updateData = { firstName, lastName, email, location };
        if (password) updateData.password = password;

        const { status, data } = await callIdentity(req, {
            method: 'PUT',
            path: `/v1/users/${req.params.id}`,
            body: updateData
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error updating admin account'));
        }
        res.json(legacyUser(data));
    } catch (error) {
        logger.error('Error updating admin account:', error);
        res.status(500).json({ message: 'Error updating admin account' });
    }
});

// Delete admin account
router.delete('/:id', isAdmin, async (req, res) => {
    try {
        const existing = await callIdentity(req, { method: 'GET', path: `/v1/users/${req.params.id}` });
        if (existing.status >= 400 || !existing.data || existing.data.role !== 'admin') {
            return res
                .status(existing.status === 502 ? 502 : 404)
                .json(existing.status === 502 ? legacyError(existing.data) : { message: 'Admin account not found' });
        }

        const { status, data } = await callIdentity(req, {
            method: 'DELETE',
            path: `/v1/users/${req.params.id}`
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error deleting admin account'));
        }
        res.json({ message: 'Admin account deleted successfully' });
    } catch (error) {
        logger.error('Error deleting admin account:', error);
        res.status(500).json({ message: 'Error deleting admin account' });
    }
});

// Get admin account by ID
router.get('/:id', isAdmin, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: `/v1/users/${req.params.id}`
        });
        if (status >= 400 || !data || data.role !== 'admin') {
            return res
                .status(status === 502 ? 502 : 404)
                .json(status === 502 ? legacyError(data) : { message: 'Admin account not found' });
        }
        res.json(legacyUser(data));
    } catch (error) {
        logger.error('Error fetching admin account:', error);
        res.status(500).json({ message: 'Error fetching admin account' });
    }
});

module.exports = router;
