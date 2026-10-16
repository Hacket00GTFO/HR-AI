const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const { validate } = require('../middleware/validate');
const schemas = require('../middleware/schemas');
const { callIdentity, legacyError } = require('../utils/serviceClient');

// ── Strangler proxy ─────────────────────────────────────────────────────────
// Settings moved to identity-auth (/v1/settings + /v1/settings/integrations).
// Integration secrets (LinkedIn/OCC) are AES-256-GCM encrypted at rest there.
// Response shapes kept identical to the pre-extraction routes.

// Get user settings — company configuration is platform-level, admin only
router.get('/', isAdmin, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, { method: 'GET', path: '/v1/settings' });
        // identity already answers {error: 'Settings not found'} etc. — the
        // legacy route used the same {error} envelope, forward as-is.
        res.status(status).json(data);
    } catch (error) {
        logger.error('Error fetching settings:', error);
        res.status(500).json({ error: 'Error fetching settings' });
    }
});

// Update company settings
router.post('/company', isAdmin, validate({ body: schemas.companySettingsBody }), async (req, res) => {
    try {
        const { name, industry, size, location } = req.body;
        const { status, data } = await callIdentity(req, {
            method: 'PUT',
            path: '/v1/settings',
            body: { company: { name, industry, size, location } }
        });
        res.status(status).json(data);
    } catch (error) {
        logger.error('Error updating company settings:', error);
        res.status(500).json({ error: 'Error updating company settings' });
    }
});

// Get API configurations (non-secret view)
router.get('/api-config', isAdmin, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: '/v1/settings/integrations'
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error fetching settings'));
        }
        res.json({
            theme: data.theme || 'light',
            notifications: data.notifications ?? true
        });
    } catch (error) {
        logger.error('Error fetching settings:', error);
        res.status(500).json({ message: 'Error fetching settings' });
    }
});

// Update LinkedIn configuration (secrets encrypted at rest by identity-auth)
router.post('/linkedin-config', isAdmin, validate({ body: schemas.linkedinConfigBody }), async (req, res) => {
    try {
        const { clientId, clientSecret, redirectUri } = req.body;
        const { status, data } = await callIdentity(req, {
            method: 'PUT',
            path: '/v1/settings/integrations',
            body: { linkedin: { clientId, clientSecret, redirectUri } }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error updating LinkedIn configuration'));
        }
        res.json({ message: 'LinkedIn configuration updated successfully' });
    } catch (error) {
        logger.error('Error updating LinkedIn configuration:', error);
        res.status(500).json({ message: 'Error updating LinkedIn configuration' });
    }
});

// Update OCC configuration
router.post('/occ-config', isAdmin, validate({ body: schemas.occConfigBody }), async (req, res) => {
    try {
        const { apiKey, apiSecret, environment } = req.body;
        const { status, data } = await callIdentity(req, {
            method: 'PUT',
            path: '/v1/settings/integrations',
            body: { occ: { apiKey, apiSecret, environment } }
        });
        if (status >= 400) {
            return res.status(status).json(legacyError(data, 'Error updating OCC configuration'));
        }
        res.json({ message: 'OCC configuration updated successfully' });
    } catch (error) {
        logger.error('Error updating OCC configuration:', error);
        res.status(500).json({ message: 'Error updating OCC configuration' });
    }
});

module.exports = router;
