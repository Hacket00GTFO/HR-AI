const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const Vacancy = require('../models/Vacancy');
const Candidate = require('../models/Candidate');
const Application = require('../models/Application');
const db = require('../db');
const logger = require('../utils/logger');
const { isHR, isAdmin } = require('../middleware/auth');
const { callIdentity } = require('../utils/serviceClient');

// GET /api/dashboard/activity
router.get('/activity', isHR, async (req, res) => {
    try {
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const candidates = await Candidate.findWithVacancyTitle(
            { appliedAfter: sevenDaysAgo, appliedBefore: sevenDaysAhead },
            { limit: 10 }
        );

        const activities = candidates
            .map((candidate) => {
                if (!candidate.applied_at) return null;

                const appliedDate = new Date(candidate.applied_at);
                const isUpcoming = appliedDate > now;
                return {
                    type: isUpcoming ? 'upcoming' : 'application',
                    description: `${candidate.first_name} ${candidate.last_name} ${isUpcoming ? 'will apply' : 'applied'} for ${candidate.applied_for?.title || 'Unknown Position'}`,
                    timestamp: candidate.applied_at,
                    icon: isUpcoming ? 'bi-calendar-plus' : 'bi-file-earmark-text'
                };
            })
            .filter((activity) => activity !== null);

        res.json(activities);
    } catch (error) {
        logger.error('Error fetching recent activity:', error);
        res.status(500).json({ error: 'Error fetching recent activity' });
    }
});

// GET /api/dashboard/application-trends
router.get('/application-trends', isHR, async (req, res) => {
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const candidates = await Candidate.find({ appliedAfter: thirtyDaysAgo }, { orderBy: 'applied_at ASC' });

        const applicationsByDate = {};
        candidates.forEach((candidate) => {
            const date = candidate.applied_at.toISOString().split('T')[0];
            if (!applicationsByDate[date]) {
                applicationsByDate[date] = { applications: 0, interviews: 0 };
            }
            applicationsByDate[date].applications++;
            if (candidate.status === 'interview') {
                applicationsByDate[date].interviews++;
            }
        });

        const trends = Object.entries(applicationsByDate).map(([date, data]) => ({
            date,
            ...data
        }));

        res.json(trends);
    } catch (error) {
        logger.error('Error fetching application trends:', error);
        res.status(500).json({ error: 'Error fetching application trends' });
    }
});

// GET /api/dashboard/department-stats — single GROUP BY query (no N+1)
router.get('/department-stats', isHR, async (req, res) => {
    try {
        const rows = await Vacancy.departmentApplicationCounts();
        const stats = rows.map((row) => ({ name: row.department, value: row.candidates }));
        res.json(stats);
    } catch (error) {
        logger.error('Error fetching department stats:', error);
        res.status(500).json({ error: 'Error fetching department stats' });
    }
});

// GET /api/dashboard/generate-report — PDF with consolidated department query
router.get('/generate-report', isHR, async (req, res) => {
    try {
        const doc = new PDFDocument();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=recruitment-report.pdf');

        doc.pipe(res);

        doc.fontSize(25).text('Recruitment Report', { align: 'center' });
        doc.moveDown();

        // Get statistics
        const totalVacancies = await Vacancy.count();
        const activeVacancies = await Vacancy.countByStatus('Active');
        const totalCandidates = await Candidate.count();
        const interviewedCandidates = await Application.countByStatus('interview');
        const hiredCandidates = await Application.countByStatus('accepted');

        doc.fontSize(16).text('Overview', { underline: true });
        doc.moveDown();
        doc.fontSize(12).text(`Total Vacancies: ${totalVacancies}`);
        doc.text(`Active Vacancies: ${activeVacancies}`);
        doc.text(`Total Candidates: ${totalCandidates}`);
        doc.text(`Interviewed Candidates: ${interviewedCandidates}`);
        doc.text(`Hired Candidates: ${hiredCandidates}`);
        doc.moveDown();

        // Department statistics — single query (no N+1 loop)
        doc.fontSize(16).text('Department Statistics', { underline: true });
        doc.moveDown();

        const deptRows = await Vacancy.departmentApplicationCounts();
        for (const row of deptRows) {
            doc.fontSize(12).text(`${row.department}: ${row.candidates} applications`);
        }

        // Recent activity
        doc.moveDown();
        doc.fontSize(16).text('Recent Activity', { underline: true });
        doc.moveDown();

        const recentCandidates = await Candidate.findWithVacancyTitle({}, { limit: 10 });

        for (const candidate of recentCandidates) {
            doc.fontSize(12).text(
                `${candidate.first_name} ${candidate.last_name} applied for ${candidate.applied_for?.title || 'Unknown Position'} on ${new Date(candidate.applied_at).toLocaleDateString()}`
            );
        }

        doc.end();
    } catch (error) {
        logger.error('Error generating report:', error);
        res.status(500).json({ error: 'Error generating report' });
    }
});

// ── Admin dashboard ─────────────────────────────────────────────────────────
// Platform-level metrics for the admin role. Strict role separation: admins
// never see recruitment or HR-operations data (those endpoints are isHR).

// GET /api/dashboard/admin/summary — account counts, recent accounts, DB health
router.get('/admin/summary', isAdmin, async (req, res) => {
    try {
        const usersRes = await callIdentity(req, {
            method: 'GET',
            path: '/v1/users?limit=500'
        });
        if (usersRes.status >= 400) {
            return res.status(502).json({ error: 'Error fetching accounts summary' });
        }

        const users = usersRes.data.data || [];
        const hrAccounts = users.filter((u) => u.role === 'hr').length;
        const adminAccounts = users.filter((u) => u.role === 'admin').length;

        const recentAccounts = [...users]
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
            .slice(0, 5)
            .map((u) => ({
                id: u.id,
                name: `${u.firstName} ${u.lastName}`.trim(),
                email: u.email,
                role: u.role,
                active: u.active,
                updatedAt: u.updatedAt
            }));

        let dbOk = false;
        try {
            await db.query('SELECT 1');
            dbOk = true;
        } catch {
            dbOk = false;
        }

        res.json({ hrAccounts, adminAccounts, dbOk, recentAccounts });
    } catch (error) {
        logger.error('Error fetching admin summary:', error);
        res.status(500).json({ error: 'Error fetching admin summary' });
    }
});

// GET /api/dashboard/admin/audit — recent account/settings audit trail
router.get('/admin/audit', isAdmin, async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const { status, data } = await callIdentity(req, {
            method: 'GET',
            path: `/v1/audit?limit=${limit}`
        });
        if (status >= 400) {
            return res.status(status === 502 ? 502 : status).json({
                error: 'Error fetching audit trail'
            });
        }
        res.json(Array.isArray(data) ? data : []);
    } catch (error) {
        logger.error('Error fetching admin audit:', error);
        res.status(500).json({ error: 'Error fetching admin audit' });
    }
});

module.exports = router;
