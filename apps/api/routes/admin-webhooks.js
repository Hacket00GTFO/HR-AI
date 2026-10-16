const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const db = require('../db');
const crypto = require('crypto');
const Webhook = require('../models/Webhook');

// All routes protected by isAdmin
router.use(isAdmin);

// Generate a random webhook secret if not provided
function generateSecret() {
    return crypto.randomBytes(32).toString('hex');
}

// GET / — list all webhooks
router.get('/', async (req, res) => {
    try {
        const webhooks = await Webhook.find();
        res.json(webhooks);
    } catch (err) {
        logger.error('Failed to list webhooks:', err);
        res.status(500).json({ error: 'Failed to list webhooks' });
    }
});

// POST / — create webhook. Body: { url, description, events, secret }
// Generate random secret if not provided. Return created webhook.
router.post('/', async (req, res) => {
    try {
        const { url, description, events, secret } = req.body;
        const webhookSecret = secret || generateSecret();

        const webhook = await Webhook.create({
            url,
            description,
            events,
            secret: webhookSecret
        });
        res.status(201).json(webhook);
    } catch (err) {
        logger.error('Failed to create webhook:', err);
        res.status(500).json({ error: 'Failed to create webhook' });
    }
});

// PUT /:id — update webhook. Body: { url, description, events, active }
router.put('/:id', async (req, res) => {
    try {
        const { url, description, events, active } = req.body;
        const webhook = await Webhook.update(req.params.id, {
            url,
            description,
            events,
            active
        });
        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' });
        }
        res.json(webhook);
    } catch (err) {
        logger.error('Failed to update webhook:', err);
        res.status(500).json({ error: 'Failed to update webhook' });
    }
});

// DELETE /:id — delete webhook
router.delete('/:id', async (req, res) => {
    try {
        const webhook = await Webhook.delete(req.params.id);
        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' });
        }
        res.json({ message: 'Webhook deleted successfully' });
    } catch (err) {
        logger.error('Failed to delete webhook:', err);
        res.status(500).json({ error: 'Failed to delete webhook' });
    }
});

// GET /:id/deliveries — list deliveries for webhook. Query param limit (default 50).
router.get('/:id/deliveries', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const deliveries = await Webhook.findDeliveries(req.params.id, limit);
        res.json(deliveries);
    } catch (err) {
        logger.error('Failed to list webhook deliveries:', err);
        res.status(500).json({ error: 'Failed to list webhook deliveries' });
    }
});

// POST /:id/deliveries/:did/retry — retry a failed delivery. Set status back to 'pending'.
router.post('/:id/deliveries/:did/retry', async (req, res) => {
    try {
        const delivery = await Webhook.updateDelivery(req.params.did, { status: 'pending' });
        if (!delivery) {
            return res.status(404).json({ error: 'Delivery not found' });
        }
        res.json(delivery);
    } catch (err) {
        logger.error('Failed to retry webhook delivery:', err);
        res.status(500).json({ error: 'Failed to retry webhook delivery' });
    }
});

module.exports = router;
