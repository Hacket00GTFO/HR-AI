const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const { callService } = require('../utils/serviceClient');
const logger = require('../utils/logger');

const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL || 'http://localhost:3002';

// The notifications service trusts gateway identity headers. The monolith is a
// trusted caller (it carries SERVICE_AUTH_TOKEN), but we still forward the
// admin's user context so upstream sees who is asking.
function userHeaders(req) {
    const headers = {};
    if (req.user && req.user.id != null) headers['X-User-Id'] = String(req.user.id);
    if (req.user && req.user.role) headers['X-User-Role'] = req.user.role;
    return headers;
}

// The service returns camelCase log entries; the admin client still expects
// the legacy snake_case shape (to_email, template, sent_at, created_at).
function mapNotification(item) {
    if (!item || typeof item !== 'object') return item;
    return {
        id: item.id,
        to_email: item.toEmail ?? item.to_email,
        template: item.templateKey ?? item.template ?? item.template_key,
        locale: item.locale,
        status: item.status,
        error: item.error ?? null,
        attempts: item.attempts,
        sent_at: item.sentAt ?? item.sent_at ?? null,
        created_at: item.createdAt ?? item.created_at
    };
}

// Accepts either the service envelope ({items, page, pageSize, total}) or a
// bare array, and always returns a bare array of mapped rows.
function mapListResponse(data) {
    const items = Array.isArray(data) ? data : Array.isArray(data && data.items) ? data.items : [];
    return items.map(mapNotification);
}

// GET / — list notifications
router.get('/', isAdmin, async (req, res) => {
    try {
        const { status, template, from, to } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = parseInt(req.query.offset, 10) || 0;

        // The service paginates with page/pageSize — translate limit/offset.
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        if (template) params.set('template', template);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        params.set('pageSize', String(limit));
        params.set('page', String(Math.floor(offset / limit) + 1));

        try {
            const data = await callService(NOTIFICATIONS_URL, '/v1/notifications?' + params.toString(), {
                method: 'GET',
                headers: userHeaders(req)
            });
            return res.json(mapListResponse(data));
        } catch (serviceErr) {
            logger.error('Notifications service unavailable:', serviceErr);
            return res.json([]);
        }
    } catch (err) {
        logger.error('Error listing notifications:', err);
        return res.status(500).json({ error: 'Failed to list notifications' });
    }
});

// GET /stats — notification stats
router.get('/stats', isAdmin, async (req, res) => {
    try {
        try {
            const stats = await callService(NOTIFICATIONS_URL, '/v1/notifications/stats', {
                method: 'GET',
                headers: userHeaders(req)
            });
            return res.json(stats);
        } catch (serviceErr) {
            logger.error('Notifications service unavailable:', serviceErr);
            return res.json({});
        }
    } catch (err) {
        logger.error('Error getting notification stats:', err);
        return res.status(500).json({ error: 'Failed to get notification stats' });
    }
});

// POST /:id/retry — retry a failed notification
router.post('/:id/retry', isAdmin, async (req, res) => {
    try {
        try {
            const result = await callService(NOTIFICATIONS_URL, '/v1/notifications/' + req.params.id + '/retry', {
                method: 'POST',
                headers: userHeaders(req)
            });
            return res.json(mapNotification(result));
        } catch (serviceErr) {
            logger.error('Notifications service unavailable:', serviceErr);
            return res.status(502).json({ error: 'Notifications service unavailable' });
        }
    } catch (err) {
        logger.error('Error retrying notification:', err);
        return res.status(500).json({ error: 'Failed to retry notification' });
    }
});

// GET /templates — list notification templates
router.get('/templates', isAdmin, async (req, res) => {
    try {
        try {
            const templates = await callService(NOTIFICATIONS_URL, '/v1/notifications/templates', {
                method: 'GET',
                headers: userHeaders(req)
            });
            return res.json(templates);
        } catch (serviceErr) {
            logger.error('Notifications service unavailable:', serviceErr);
            return res.json([]);
        }
    } catch (err) {
        logger.error('Error listing notification templates:', err);
        return res.status(500).json({ error: 'Failed to list notification templates' });
    }
});

module.exports = router;
