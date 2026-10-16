const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const db = require('../db');
const logger = require('../utils/logger');

// GET /overview — platform metrics
router.get('/overview', isAdmin, async (req, res) => {
    try {
        const totalVacancies = await db.query('SELECT COUNT(*) FROM vacancies');
        const activeVacancies = await db.query("SELECT COUNT(*) FROM vacancies WHERE status='Active'");
        const totalCandidates = await db.query('SELECT COUNT(*) FROM candidates');
        const totalApplications = await db.query('SELECT COUNT(*) FROM applications');
        const applicationsLast30Days = await db.query(
            "SELECT COUNT(*) FROM applications WHERE created_at >= NOW() - INTERVAL '30 days'"
        );
        const hiredCandidates = await db.query("SELECT COUNT(*) FROM applications WHERE status='accepted'");
        const funnel = await db.query(
            "SELECT COALESCE(status, 'unknown') AS status, COUNT(*) as count FROM applications GROUP BY status"
        );
        const vacanciesByDepartment = await db.query(
            "SELECT COALESCE(department, '—') AS department, COUNT(*) as count FROM vacancies GROUP BY department"
        );

        res.json({
            totalVacancies: parseInt(totalVacancies.rows[0].count, 10),
            activeVacancies: parseInt(activeVacancies.rows[0].count, 10),
            totalCandidates: parseInt(totalCandidates.rows[0].count, 10),
            totalApplications: parseInt(totalApplications.rows[0].count, 10),
            applicationsLast30Days: parseInt(applicationsLast30Days.rows[0].count, 10),
            hiredCandidates: parseInt(hiredCandidates.rows[0].count, 10),
            funnel: funnel.rows,
            vacanciesByDepartment: vacanciesByDepartment.rows
        });
    } catch (err) {
        logger.error('Error fetching analytics overview: %O', err);
        res.status(500).json({ error: 'Failed to fetch analytics overview' });
    }
});

// GET /trends — time series
router.get('/trends', isAdmin, async (req, res) => {
    try {
        const { metric, period } = req.query;
        const validMetrics = ['applications', 'vacancies'];
        const validPeriods = ['7d', '30d', '90d'];

        if (!validMetrics.includes(metric)) {
            return res.status(400).json({ error: 'Invalid metric' });
        }
        if (!validPeriods.includes(period)) {
            return res.status(400).json({ error: 'Invalid period' });
        }

        const interval = period;

        let rows;
        if (metric === 'applications') {
            const result = await db.query(
                `SELECT DATE(created_at) as date, COUNT(*) as value FROM applications WHERE created_at >= NOW() - INTERVAL '${interval}' GROUP BY DATE(created_at) ORDER BY date`
            );
            rows = result.rows;
        } else if (metric === 'vacancies') {
            const result = await db.query(
                `SELECT DATE(created_at) as date, COUNT(*) as value FROM vacancies WHERE created_at >= NOW() - INTERVAL '${interval}' GROUP BY DATE(created_at) ORDER BY date`
            );
            rows = result.rows;
        }

        res.json({
            metric,
            period,
            data: rows
        });
    } catch (err) {
        logger.error('Error fetching analytics trends: %O', err);
        res.status(500).json({ error: 'Failed to fetch analytics trends' });
    }
});

// GET /export — export metrics as CSV
router.get('/export', isAdmin, async (req, res) => {
    try {
        const totalVacancies = await db.query('SELECT COUNT(*) FROM vacancies');
        const activeVacancies = await db.query("SELECT COUNT(*) FROM vacancies WHERE status='Active'");
        const totalCandidates = await db.query('SELECT COUNT(*) FROM candidates');
        const totalApplications = await db.query('SELECT COUNT(*) FROM applications');
        const applicationsLast30Days = await db.query(
            "SELECT COUNT(*) FROM applications WHERE created_at >= NOW() - INTERVAL '30 days'"
        );
        const hiredCandidates = await db.query("SELECT COUNT(*) FROM applications WHERE status='accepted'");
        const funnel = await db.query(
            "SELECT COALESCE(status, 'unknown') AS status, COUNT(*) as count FROM applications GROUP BY status"
        );
        const vacanciesByDepartment = await db.query(
            "SELECT COALESCE(department, '—') AS department, COUNT(*) as count FROM vacancies GROUP BY department"
        );

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="analytics-overview.csv"');

        let csv = 'metric,value\n';
        csv += `totalVacancies,${totalVacancies.rows[0].count}\n`;
        csv += `activeVacancies,${activeVacancies.rows[0].count}\n`;
        csv += `totalCandidates,${totalCandidates.rows[0].count}\n`;
        csv += `totalApplications,${totalApplications.rows[0].count}\n`;
        csv += `applicationsLast30Days,${applicationsLast30Days.rows[0].count}\n`;
        csv += `hiredCandidates,${hiredCandidates.rows[0].count}\n`;

        csv += '\nfunnel_status,count\n';
        for (const row of funnel.rows) {
            csv += `${row.status},${row.count}\n`;
        }

        csv += '\nvacancies_by_department,count\n';
        for (const row of vacanciesByDepartment.rows) {
            csv += `${row.department},${row.count}\n`;
        }

        res.send(csv);
    } catch (err) {
        logger.error('Error exporting analytics: %O', err);
        res.status(500).json({ error: 'Failed to export analytics' });
    }
});

module.exports = router;
