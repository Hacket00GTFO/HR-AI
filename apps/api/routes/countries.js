const express = require('express');
const router = express.Router();
const db = require('../db');
const logger = require('../utils/logger');

// Countries/states are DB-authoritative — seeded by migration
// 0008_reference_embeddings from data/countries.js (kept as the seed source).

// Get list of all countries
router.get('/', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT name FROM countries ORDER BY name');
        res.json(rows.map((r) => r.name));
    } catch (error) {
        logger.error('Error fetching countries:', error);
        res.status(500).json({ message: 'Error fetching countries' });
    }
});

// Get states/regions for a specific country
router.get('/:country/states', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT s.name
             FROM states s
             JOIN countries c ON c.id = s.country_id
             WHERE c.name = $1
             ORDER BY s.name`,
            [req.params.country]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Country not found' });
        }
        res.json(rows.map((r) => r.name));
    } catch (error) {
        logger.error('Error fetching states:', error);
        res.status(500).json({ message: 'Error fetching states' });
    }
});

module.exports = router;
