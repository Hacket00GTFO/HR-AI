const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const { callIdentity } = require('../utils/serviceClient');
const logger = require('../utils/logger');

// GET /api/admin/audit — advanced audit trail with filters, pagination, export.
// Proxies to identity-auth /v1/audit which supports query params.
router.get('/', isAdmin, async (req, res) => {
    try {
        const { actor, action, entity, from, to, format, limit, offset, sort } = req.query;

        // Build query string for identity service
        const params = new URLSearchParams();
        const maxLimit = format === 'csv' || format === 'json' ? 10000 : 200;
        const effectiveLimit = Math.min(Math.max(Number(limit) || 50, 1), maxLimit);
        params.set('limit', String(effectiveLimit));
        if (offset) params.set('offset', String(offset));
        if (actor) params.set('actor', String(actor));
        if (action) params.set('action', String(action));
        if (entity) params.set('entity', String(entity));
        if (from) params.set('from', String(from));
        if (to) params.set('to', String(to));
        if (sort) params.set('sort', String(sort));

        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: `/v1/audit?${params.toString()}`
        });

        if (status >= 400) {
            return res.status(status === 502 ? 502 : status).json({
                error: 'Error fetching audit trail'
            });
        }

        const rows = Array.isArray(data) ? data : [];

        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
            const headers = ['id', 'timestamp', 'actor', 'action', 'entity', 'entityId', 'metadata'];
            res.write(headers.join(',') + '\n');
            for (const r of rows) {
                const row = [
                    r.id ?? '',
                    r.timestamp ?? '',
                    r.actorRole ?? (r.actorId != null ? `#${r.actorId}` : ''),
                    r.action ?? '',
                    r.entity ?? '',
                    r.entityId ?? '',
                    JSON.stringify(r.metadata ?? {})
                ];
                // Escape CSV values
                res.write(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n');
            }
            return res.end();
        }

        res.json({ data: rows, total: rows.length, limit: effectiveLimit, offset: Number(offset) || 0 });
    } catch (error) {
        logger.error('Error fetching admin audit:', error);
        res.status(500).json({ error: 'Error fetching admin audit' });
    }
});

// GET /api/admin/audit/stats — aggregations for charts
router.get('/stats', isAdmin, async (req, res) => {
    try {
        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: '/v1/audit?limit=1000'
        });

        if (status >= 400) {
            return res.status(status === 502 ? 502 : status).json({
                error: 'Error fetching audit stats'
            });
        }

        const rows = Array.isArray(data) ? data : [];

        // Aggregate in-memory since identity returns raw rows
        const byAction = {};
        const byActor = {};
        const byEntity = {};
        const byDay = {};

        for (const r of rows) {
            const action = r.action || 'unknown';
            byAction[action] = (byAction[action] || 0) + 1;

            const actor = r.actorRole || (r.actorId != null ? `#${r.actorId}` : 'system');
            byActor[actor] = (byActor[actor] || 0) + 1;

            const entity = r.entity || 'unknown';
            byEntity[entity] = (byEntity[entity] || 0) + 1;

            const day = r.timestamp ? new Date(r.timestamp).toISOString().split('T')[0] : 'unknown';
            byDay[day] = (byDay[day] || 0) + 1;
        }

        const topActions = Object.entries(byAction)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([action, count]) => ({ action, count }));

        const topActors = Object.entries(byActor)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([actor, count]) => ({ actor, count }));

        const entities = Object.entries(byEntity)
            .sort((a, b) => b[1] - a[1])
            .map(([entity, count]) => ({ entity, count }));

        const eventsByDay = Object.entries(byDay)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([date, count]) => ({ date, count }));

        res.json({
            total: rows.length,
            topActions,
            topActors,
            entities,
            eventsByDay
        });
    } catch (error) {
        logger.error('Error fetching audit stats:', error);
        res.status(500).json({ error: 'Error fetching audit stats' });
    }
});

module.exports = router;
