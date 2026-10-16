const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const db = require('../db');
const JobExecution = require('../models/JobExecution');

// All routes protected by isAdmin
router.use(isAdmin);

// GET / — list jobs with optional filters
router.get('/', async (req, res) => {
    try {
        const { status, queue } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = parseInt(req.query.offset, 10) || 0;

        const filters = {};
        if (status) filters.status = status;
        if (queue) filters.queue = queue;

        const data = await JobExecution.find({ ...filters, limit, offset });
        const total = data.length + offset; // best-effort total when model doesn't return it

        res.json({ data, total, limit, offset });
    } catch (err) {
        logger.error('Failed to list jobs:', err);
        res.status(500).json({ error: 'Failed to list jobs' });
    }
});

// GET /stats — job execution stats
router.get('/stats', async (req, res) => {
    try {
        const stats = await JobExecution.stats();
        res.json(stats);
    } catch (err) {
        logger.error('Failed to get job stats:', err);
        res.status(500).json({ error: 'Failed to get job stats' });
    }
});

// GET /:id — single job by id
router.get('/:id', async (req, res) => {
    try {
        const job = await JobExecution.findById(req.params.id);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.json(job);
    } catch (err) {
        logger.error('Failed to get job:', err);
        res.status(500).json({ error: 'Failed to get job' });
    }
});

// POST /:queue/retry — retry failed jobs in a queue
router.post('/:queue/retry', async (req, res) => {
    try {
        const { queue } = req.params;
        const result = await db.query(
            `UPDATE job_executions SET status='pending', error=NULL, started_at=NULL, completed_at=NULL WHERE queue=$1 AND status='failed' RETURNING id`,
            [queue]
        );
        const count = result.rows.length;
        res.json({ retried: count });
    } catch (err) {
        logger.error('Failed to retry jobs:', err);
        res.status(500).json({ error: 'Failed to retry jobs' });
    }
});

// DELETE /:queue/failed — purge failed jobs for a queue
router.delete('/:queue/failed', async (req, res) => {
    try {
        const { queue } = req.params;
        const result = await db.query(`DELETE FROM job_executions WHERE queue=$1 AND status='failed' RETURNING id`, [
            queue
        ]);
        const count = result.rows.length;
        res.json({ purged: count });
    } catch (err) {
        logger.error('Failed to purge jobs:', err);
        res.status(500).json({ error: 'Failed to purge jobs' });
    }
});

module.exports = router;
