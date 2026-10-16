// Admin alerts route — receives Alertmanager webhooks + provides alert CRUD.
// The webhook endpoint (POST /webhook) is NOT behind isAdmin — it uses
// a separate Bearer token (ALERT_WEBHOOK_TOKEN) with constant-time comparison.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { isAdmin } = require('../middleware/auth');
const Alert = require('../models/Alert');
const logger = require('../utils/logger');

const router = express.Router();

// Webhook rate limiter (separate from the global API limiter)
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many webhook calls' }
});

// Bearer token verification for the webhook
function requireWebhookToken(req, res, next) {
    const expected = process.env.ALERT_WEBHOOK_TOKEN;
    if (!expected) {
        return res.status(503).json({ error: 'ALERT_WEBHOOK_TOKEN not configured' });
    }
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (
        !provided ||
        provided.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// POST /api/admin/alerts/webhook — Alertmanager webhook receiver
// NOT behind isAdmin — uses ALERT_WEBHOOK_TOKEN instead.
router.post('/webhook', webhookLimiter, requireWebhookToken, async (req, res) => {
    try {
        const payload = req.body;
        if (!payload || !Array.isArray(payload.alerts)) {
            return res.status(400).json({ error: 'Invalid Alertmanager payload' });
        }

        const results = [];
        for (const alert of payload.alerts) {
            if (!alert.fingerprint) continue;
            try {
                const result = await Alert.upsertFromAlertmanager(alert);
                results.push({ fingerprint: alert.fingerprint, status: result.status });
            } catch (err) {
                logger.error('Failed to upsert alert:', err.message);
                results.push({ fingerprint: alert.fingerprint, error: 'upsert_failed' });
            }
        }

        res.status(202).json({ received: payload.alerts.length, results });
    } catch (err) {
        logger.error('Alert webhook error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// All remaining routes require admin
router.use(isAdmin);

// GET /api/admin/alerts — list alerts with filters
router.get('/', async (req, res) => {
    try {
        const alerts = await Alert.find({
            status: req.query.status,
            severity: req.query.severity,
            service: req.query.service,
            limit: parseInt(req.query.limit, 10) || 50,
            offset: parseInt(req.query.offset, 10) || 0
        });
        res.json({ alerts });
    } catch (err) {
        logger.error('Failed to list alerts:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /api/admin/alerts/count — counts for nav badge
router.get('/count', async (req, res) => {
    try {
        const counts = await Alert.countByStatus();
        res.json({
            firing: parseInt(counts.firing, 10) || 0,
            critical: parseInt(counts.critical, 10) || 0,
            warning: parseInt(counts.warning, 10) || 0
        });
    } catch (err) {
        logger.error('Failed to count alerts:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// POST /api/admin/alerts/:id/ack — acknowledge an alert
router.post('/:id/ack', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid alert ID' });
        }
        const alert = await Alert.acknowledge(id, req.user.userId);
        if (!alert) {
            return res.status(404).json({ error: 'Alert not found' });
        }
        res.json({ alert });
    } catch (err) {
        logger.error('Failed to acknowledge alert:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /api/admin/alerts/active — proxy to Alertmanager active alerts
router.get('/active', async (req, res) => {
    try {
        const url = process.env.ALERTMANAGER_URL || 'http://alertmanager:9093';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const amRes = await fetch(`${url}/api/v2/alerts?active=true`, { signal: controller.signal });
        clearTimeout(timer);
        if (!amRes.ok) {
            return res.status(502).json({ error: 'Alertmanager returned ' + amRes.status });
        }
        const alerts = await amRes.json();
        res.json({ alerts });
    } catch (err) {
        res.status(503).json({ error: 'Alertmanager not reachable' });
    }
});

// POST /api/admin/alerts/silences — create a silence in Alertmanager
router.post('/silences', async (req, res) => {
    try {
        const { matchers, durationHours, comment } = req.body;
        if (!matchers || !Array.isArray(matchers) || matchers.length === 0) {
            return res.status(400).json({ error: 'matchers array is required' });
        }
        const hours = Math.min(Math.max(durationHours || 1, 1), 24);
        const endsAt = new Date(Date.now() + hours * 60 * 60 * 1000);

        const payload = {
            matchers,
            startsAt: new Date().toISOString(),
            endsAt: endsAt.toISOString(),
            createdBy: req.user.email,
            comment: comment || `Silenced by ${req.user.email}`
        };

        const url = process.env.ALERTMANAGER_URL || 'http://alertmanager:9093';
        const amRes = await fetch(`${url}/api/v2/silences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!amRes.ok) {
            const text = await amRes.text();
            return res.status(amRes.status).json({ error: 'Alertmanager error', detail: text });
        }
        const result = await amRes.json();
        res.json(result);
    } catch (err) {
        logger.error('Failed to create silence:', err);
        res.status(503).json({ error: 'Alertmanager not reachable' });
    }
});

module.exports = router;
