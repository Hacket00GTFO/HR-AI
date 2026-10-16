const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const db = require('../db');
const crypto = require('crypto');
const ApiKey = require('../models/ApiKey');

// All routes protected by isAdmin
router.use(isAdmin);

// Generate a new API key string: sk_live_ + 32 random hex chars
function generateApiKey() {
    return 'sk_live_' + crypto.randomBytes(16).toString('hex');
}

// SHA-256 hash of the key for storage
function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

// GET / — list all API keys (do not expose key_hash)
router.get('/', async (req, res) => {
    try {
        const includeRevoked = req.query.includeRevoked === '1' || req.query.includeRevoked === 'true';
        const keys = await ApiKey.find({ includeRevoked });
        const safe = (keys || []).map((k) => {
            const { key_hash, ...rest } = k;
            return rest;
        });
        res.json(safe);
    } catch (err) {
        logger.error('Failed to list API keys:', err);
        res.status(500).json({ error: 'Failed to list API keys' });
    }
});

// POST / — create API key. Body: { name, scopes, expires_at }
// Returns { ...key, secret } where secret is the full key (shown only once)
router.post('/', async (req, res) => {
    try {
        const { name, scopes, expires_at } = req.body;
        const secret = generateApiKey();
        const key_hash = hashKey(secret);
        const prefix = secret.slice(0, 12);

        const key = await ApiKey.create({
            name,
            scopes: JSON.stringify(scopes || ['read']),
            expires_at,
            key_hash,
            key_prefix: prefix
        });

        const { key_hash: _omit, ...safe } = key;
        res.status(201).json({ ...safe, secret });
    } catch (err) {
        logger.error('Failed to create API key:', err);
        res.status(500).json({ error: 'Failed to create API key' });
    }
});

// POST /:id/rotate — rotate key. Generate new key, update hash/prefix. Return new secret.
router.post('/:id/rotate', async (req, res) => {
    try {
        const existing = await ApiKey.findById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'API key not found' });
        }

        const secret = generateApiKey();
        const key_hash = hashKey(secret);
        const prefix = secret.slice(0, 12);

        // Update the key hash and prefix directly since the model doesn't have
        // a generic update method for these fields.
        const { rows } = await db.query(
            'UPDATE api_keys SET key_hash = $1, key_prefix = $2 WHERE id = $3 AND revoked_at IS NULL RETURNING *',
            [key_hash, prefix, req.params.id]
        );
        const key = rows[0];
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }

        const { key_hash: _omit, ...safe } = key;
        res.json({ ...safe, secret });
    } catch (err) {
        logger.error('Failed to rotate API key:', err);
        res.status(500).json({ error: 'Failed to rotate API key' });
    }
});

// DELETE /:id — revoke key. Set revoked_at to now().
router.delete('/:id', async (req, res) => {
    try {
        const key = await ApiKey.revoke(req.params.id);
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }
        res.json({ message: 'API key revoked successfully' });
    } catch (err) {
        logger.error('Failed to revoke API key:', err);
        res.status(500).json({ error: 'Failed to revoke API key' });
    }
});

// GET /:id — get single key details
router.get('/:id', async (req, res) => {
    try {
        const key = await ApiKey.findById(req.params.id);
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }
        const { key_hash, ...safe } = key;
        res.json(safe);
    } catch (err) {
        logger.error('Failed to get API key:', err);
        res.status(500).json({ error: 'Failed to get API key' });
    }
});

module.exports = router;
