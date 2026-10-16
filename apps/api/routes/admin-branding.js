const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const Branding = require('../models/Branding');

// GET / — get current branding config
router.get('/', isAdmin, async (req, res) => {
    try {
        const branding = await Branding.get();
        res.json(branding || {});
    } catch (err) {
        logger.error('Error fetching branding config:', err);
        res.status(500).json({ error: 'Failed to fetch branding config' });
    }
});

// PUT / — update branding config
router.put('/', isAdmin, async (req, res) => {
    try {
        const { logo_url, primary_color, secondary_color, font_family, custom_domain, custom_css } = req.body;

        const branding = await Branding.update(
            { logo_url, primary_color, secondary_color, font_family, custom_domain, custom_css },
            req.user.id
        );
        res.json(branding);
    } catch (err) {
        logger.error('Error updating branding config:', err);
        res.status(500).json({ error: 'Failed to update branding config' });
    }
});

module.exports = router;
