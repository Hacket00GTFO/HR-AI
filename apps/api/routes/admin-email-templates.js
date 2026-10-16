const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const EmailTemplate = require('../models/EmailTemplate');
const { callService, ServiceError } = require('../utils/serviceClient');
const audit = require('../utils/audit');

const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL || 'http://localhost:3002';
const TEST_SEND_TEMPLATE = 'admin.test_send';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function loadTemplate(name) {
    if (typeof EmailTemplate.findByName === 'function') return EmailTemplate.findByName(name);
    const all = await EmailTemplate.find();
    return Array.isArray(all) ? all.find((t) => t.name === name) || null : all;
}

function renderTemplateText(text, data) {
    if (!text) return text;
    let rendered = text;
    for (const [key, value] of Object.entries(data || {})) {
        rendered = rendered.replace(new RegExp('{{' + key + '}}', 'g'), value);
    }
    return rendered;
}

// GET / — list all templates
router.get('/', isAdmin, async (req, res) => {
    try {
        const templates = await EmailTemplate.find();
        return res.json(templates);
    } catch (err) {
        logger.error('Error listing email templates:', err);
        return res.status(500).json({ error: 'Failed to list email templates' });
    }
});

// GET /:name — get template by name
router.get('/:name', isAdmin, async (req, res) => {
    try {
        const template = await EmailTemplate.findByName(req.params.name);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
        return res.json(template);
    } catch (err) {
        logger.error('Error getting email template:', err);
        return res.status(500).json({ error: 'Failed to get email template' });
    }
});

// PUT /:name — update template
router.put('/:name', isAdmin, async (req, res) => {
    try {
        const { subject, html_body, text_body, variables, locale } = req.body;
        const body = { subject, html_body, text_body, variables, locale };
        const updated = await EmailTemplate.update(req.params.name, body, req.user.id);
        if (!updated) {
            return res.status(404).json({ error: 'Template not found' });
        }
        return res.json(updated);
    } catch (err) {
        logger.error('Error updating email template:', err);
        return res.status(500).json({ error: 'Failed to update email template' });
    }
});

// POST /:name/preview — render template with mock data
router.post('/:name/preview', isAdmin, async (req, res) => {
    try {
        const template = await EmailTemplate.findByName(req.params.name);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
        const data = req.body.data || {};
        const render = (text) => {
            if (!text) return text;
            let rendered = text;
            for (const [key, value] of Object.entries(data)) {
                rendered = rendered.replace(new RegExp('{{' + key + '}}', 'g'), value);
            }
            return rendered;
        };
        const renderedHtml = render(template.html_body);
        const renderedSubject = render(template.subject);
        return res.json({ html: renderedHtml, subject: renderedSubject });
    } catch (err) {
        logger.error('Error previewing email template:', err);
        return res.status(500).json({ error: 'Failed to preview email template' });
    }
});

// POST /:name/test-send — render the template and queue a real delivery
// through the notifications service (SMTP). Returns the upstream result;
// never claims success when nothing was queued.
router.post('/:name/test-send', isAdmin, async (req, res) => {
    try {
        const { to, data, locale } = req.body || {};
        if (!to || !EMAIL_RE.test(to)) {
            return res.status(400).json({ error: 'A valid recipient email (to) is required' });
        }
        const template = await loadTemplate(req.params.name);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }

        const renderedSubject = renderTemplateText(template.subject, data) || '';
        const renderedHtml = renderTemplateText(template.html_body, data) || '';
        const renderedText =
            renderTemplateText(template.text_body, data) ||
            renderedHtml
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        const result = await callService(NOTIFICATIONS_URL, '/v1/notifications/send', {
            method: 'POST',
            headers: { 'Idempotency-Key': `test-send-${req.params.name}-${randomUUID()}` },
            correlationId: req.correlationId,
            body: {
                to,
                template: TEST_SEND_TEMPLATE,
                locale: typeof locale === 'string' ? locale : 'es',
                payload: { subject: renderedSubject, bodyText: renderedText, bodyHtml: renderedHtml }
            }
        });

        await audit.record({
            actorId: req.user.id,
            action: 'email_template.test_send',
            entity: 'email_templates',
            entityId: null,
            metadata: { template: req.params.name, to, notificationId: result?.id ?? null }
        });

        return res.status(202).json({ sent: true, queued: true, to, notification: result });
    } catch (err) {
        if (err instanceof ServiceError) {
            logger.error('Test email send failed upstream:', err.message);
            const status = err.code === 'timeout' ? 504 : err.code === 'unavailable' ? 503 : err.status || 502;
            return res.status(status).json({ error: 'Email delivery service error', detail: err.message });
        }
        logger.error('Error sending test email:', err);
        return res.status(500).json({ error: 'Failed to send test email' });
    }
});

// GET /:name/versions — get version history
router.get('/:name/versions', isAdmin, async (req, res) => {
    try {
        const versions = await EmailTemplate.getVersions(req.params.name);
        return res.json(versions);
    } catch (err) {
        logger.error('Error getting template versions:', err);
        return res.status(500).json({ error: 'Failed to get template versions' });
    }
});

module.exports = router;
