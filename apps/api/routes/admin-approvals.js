const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const db = require('../db');
const Approval = require('../models/Approval');

// All routes protected by isAdmin
router.use(isAdmin);

// GET /workflows — list all approval workflows
router.get('/workflows', async (req, res) => {
    try {
        const workflows = await Approval.findWorkflows();
        res.json(workflows);
    } catch (err) {
        logger.error('Failed to list approval workflows:', err);
        res.status(500).json({ error: 'Failed to list approval workflows' });
    }
});

// POST /workflows — create workflow. Body: { name, entity_type, rules }
router.post('/workflows', async (req, res) => {
    try {
        const { name, entity_type, rules } = req.body;
        const workflow = await Approval.createWorkflow({
            name,
            entity_type,
            rules
        });
        res.status(201).json(workflow);
    } catch (err) {
        logger.error('Failed to create approval workflow:', err);
        res.status(500).json({ error: 'Failed to create approval workflow' });
    }
});

// PUT /workflows/:id — update workflow. Body: { name, entity_type, rules, active }
router.put('/workflows/:id', async (req, res) => {
    try {
        const { name, entity_type, rules, active } = req.body;
        const workflow = await Approval.updateWorkflow(req.params.id, {
            name,
            entity_type,
            rules,
            active
        });
        if (!workflow) {
            return res.status(404).json({ error: 'Approval workflow not found' });
        }
        res.json(workflow);
    } catch (err) {
        logger.error('Failed to update approval workflow:', err);
        res.status(500).json({ error: 'Failed to update approval workflow' });
    }
});

// GET /pending — list pending approval requests
router.get('/pending', async (req, res) => {
    try {
        const requests = await Approval.findPendingRequests();
        res.json(requests);
    } catch (err) {
        logger.error('Failed to list pending approvals:', err);
        res.status(500).json({ error: 'Failed to list pending approvals' });
    }
});

// POST /:id/approve — approve a request. Sets approved_by to req.user.id.
router.post('/:id/approve', async (req, res) => {
    try {
        const request = await Approval.approve(req.params.id, req.user.id);
        if (!request) {
            return res.status(404).json({ error: 'Approval request not found' });
        }
        res.json(request);
    } catch (err) {
        logger.error('Failed to approve request:', err);
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

// POST /:id/reject — reject a request. Body: { reason }. Sets approved_by to req.user.id.
router.post('/:id/reject', async (req, res) => {
    try {
        const { reason } = req.body;
        const request = await Approval.reject(req.params.id, req.user.id, reason);
        if (!request) {
            return res.status(404).json({ error: 'Approval request not found' });
        }
        res.json(request);
    } catch (err) {
        logger.error('Failed to reject request:', err);
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

module.exports = router;
