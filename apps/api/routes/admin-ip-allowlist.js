const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const IpAllowlist = require('../models/IpAllowlist');

// @route   GET /
// @desc    List all IP allowlist entries
// @access  Admin
router.get('/', isAdmin, async (req, res) => {
    try {
        const entries = await IpAllowlist.find();
        res.json(entries);
    } catch (err) {
        logger.error('Error fetching IP allowlist entries:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /
// @desc    Create a new IP allowlist entry
// @access  Admin
router.post('/', isAdmin, async (req, res) => {
    try {
        const { ip_cidr, label, applies_to } = req.body;
        const entry = await IpAllowlist.create({
            ip_cidr,
            label,
            applies_to,
            created_by: req.user.id
        });
        res.status(201).json(entry);
    } catch (err) {
        logger.error('Error creating IP allowlist entry:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   DELETE /:id
// @desc    Delete an IP allowlist entry
// @access  Admin
router.delete('/:id', isAdmin, async (req, res) => {
    try {
        const deleted = await IpAllowlist.findByIdAndDelete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ message: 'Entry not found' });
        }
        res.json({ message: 'deleted' });
    } catch (err) {
        logger.error('Error deleting IP allowlist entry:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
