const express = require('express');
const router = express.Router();
const {
    Employee,
    Attendance,
    LeaveRequest,
    PerformanceReview,
    TrainingProgram,
    TrainingEnrollment,
    PayrollRecord,
    BenefitPlan,
    EmployeeBenefit
} = require('../models/HR');
const logger = require('../utils/logger');
const { isHR } = require('../middleware/auth');

// Log only err.message — pg error objects can carry query text/parameters
// (PII) into the log stream.
const errMsg = (err) => (err instanceof Error ? err.message : String(err));

// Generic CRUD route factory
function crudRoutes(modelName, model, { allowCreate = true, allowUpdate = true, allowDelete = true } = {}) {
    const r = express.Router();
    r.use(isHR);
    r.get('/', async (req, res) => {
        try {
            const rows = await model.find(req.query);
            res.json(rows);
        } catch (err) {
            logger.error(`${modelName}.find: ${errMsg(err)}`);
            res.status(500).json({ error: `Error fetching ${modelName}` });
        }
    });
    r.get('/:id', async (req, res) => {
        try {
            const row = await model.findById(req.params.id);
            if (!row) return res.status(404).json({ error: 'Not found' });
            res.json(row);
        } catch (err) {
            logger.error(`${modelName}.findById: ${errMsg(err)}`);
            res.status(500).json({ error: `Error fetching ${modelName}` });
        }
    });
    if (allowCreate) {
        r.post('/', async (req, res) => {
            try {
                const row = await model.create(req.body);
                res.status(201).json(row);
            } catch (err) {
                logger.error(`${modelName}.create: ${errMsg(err)}`);
                res.status(500).json({ error: `Error creating ${modelName}` });
            }
        });
    }
    if (allowUpdate) {
        r.put('/:id', async (req, res) => {
            try {
                const row = await model.update(req.params.id, req.body);
                if (!row) return res.status(404).json({ error: 'Not found' });
                res.json(row);
            } catch (err) {
                logger.error(`${modelName}.update: ${errMsg(err)}`);
                res.status(500).json({ error: `Error updating ${modelName}` });
            }
        });
    }
    if (allowDelete) {
        r.delete('/:id', async (req, res) => {
            try {
                await model.remove(req.params.id);
                res.status(204).end();
            } catch (err) {
                logger.error(`${modelName}.delete: ${errMsg(err)}`);
                res.status(500).json({ error: `Error deleting ${modelName}` });
            }
        });
    }
    return r;
}

router.use('/employees', crudRoutes('employees', Employee));
router.use('/attendance', crudRoutes('attendance', Attendance));
router.use('/leave-requests', crudRoutes('leave_requests', LeaveRequest));
router.use('/performance-reviews', crudRoutes('performance_reviews', PerformanceReview));
router.use('/training-programs', crudRoutes('training_programs', TrainingProgram));
router.use('/training-enrollments', crudRoutes('training_enrollments', TrainingEnrollment));
router.use('/payroll', crudRoutes('payroll', PayrollRecord));
router.use('/benefit-plans', crudRoutes('benefit_plans', BenefitPlan));
router.use('/employee-benefits', crudRoutes('employee_benefits', EmployeeBenefit));

module.exports = router;
