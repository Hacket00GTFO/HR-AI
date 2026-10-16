const db = require('../db');

// Generic CRUD model factory for HR tables. Each table follows the same
// pattern: id, soft-delete (where applicable), created_at/updated_at.
// `filterable` is an explicit allowlist of columns usable as ?col=value
// filters; `searchColumns` are the columns a ?q= term matches via ILIKE.
// Any other query key is ignored — column names never come from the client.
function createModel(table, opts = {}) {
    const softDelete = opts.softDelete ?? false;
    const filterable = new Set(opts.filterable ?? []);
    const searchColumns = opts.searchColumns ?? [];

    async function find(filters = {}) {
        const where = [softDelete ? `${table}.deleted_at IS NULL` : 'TRUE'];
        const params = [];
        for (const [key, value] of Object.entries(filters)) {
            if (value == null || value === '') continue;
            if (key === 'q') {
                if (searchColumns.length === 0) continue;
                params.push(`%${value}%`);
                const p = `$${params.length}`;
                where.push(`(${searchColumns.map((c) => `${table}.${c}::text ILIKE ${p}`).join(' OR ')})`);
                continue;
            }
            if (!filterable.has(key)) continue;
            params.push(value);
            where.push(`${table}.${key} = $${params.length}`);
        }
        const rows = await db.query(
            `SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
            params
        );
        return rows.rows.map(db.withId);
    }

    async function findById(id) {
        const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
        return rows[0] ? db.withId(rows[0]) : null;
    }

    async function create(data) {
        const keys = Object.keys(data).filter((k) => data[k] !== undefined);
        const values = keys.map((k) => data[k]);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const cols = keys.join(', ');
        const { rows } = await db.query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`, values);
        return db.withId(rows[0]);
    }

    async function update(id, data) {
        const keys = Object.keys(data).filter((k) => data[k] !== undefined);
        if (keys.length === 0) return findById(id);
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const values = keys.map((k) => data[k]);
        const { rows } = await db.query(`UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
        return rows[0] ? db.withId(rows[0]) : null;
    }

    async function remove(id) {
        if (softDelete) {
            await db.query(`UPDATE ${table} SET deleted_at = now() WHERE id = $1`, [id]);
        } else {
            await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        }
    }

    return { find, findById, create, update, remove };
}

module.exports = {
    Employee: createModel('employees', {
        softDelete: true,
        filterable: [
            'status',
            'department',
            'position',
            'employment_type',
            'location',
            'manager_id',
            'legal_entity',
            'site',
            'user_id'
        ],
        searchColumns: ['employee_number', 'first_name', 'last_name', 'email', 'position', 'rfc', 'curp']
    }),
    Attendance: createModel('attendance', {
        filterable: ['employee_id', 'date', 'status']
    }),
    LeaveRequest: createModel('leave_requests', {
        filterable: ['employee_id', 'leave_type', 'status', 'approved_by']
    }),
    PerformanceReview: createModel('performance_reviews', {
        filterable: ['employee_id', 'reviewer_id', 'review_period', 'status']
    }),
    TrainingProgram: createModel('training_programs', {
        softDelete: true,
        filterable: ['status', 'category', 'provider'],
        searchColumns: ['title', 'description']
    }),
    TrainingEnrollment: createModel('training_enrollments', {
        filterable: ['program_id', 'employee_id', 'status']
    }),
    PayrollRecord: createModel('payroll_records', {
        filterable: ['employee_id', 'pay_period', 'status', 'currency']
    }),
    BenefitPlan: createModel('benefit_plans', {
        softDelete: true,
        filterable: ['status', 'category', 'provider'],
        searchColumns: ['name', 'description']
    }),
    EmployeeBenefit: createModel('employee_benefits', {
        filterable: ['employee_id', 'benefit_plan_id', 'status']
    })
};
