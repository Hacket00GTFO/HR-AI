/**
 * 0011_hr_modules — operational HR tables: employees, attendance, leave,
 * performance reviews, training, payroll, benefits.
 *
 * All tables reference users(id) at the application level (FK dropped in 0010
 * because users now live in strafor_identity). The columns are kept for
 * referential integrity by id matching.
 */
exports.up = (pgm) => {
    // ---- employees ----
    pgm.createTable('employees', {
        id: 'id',
        user_id: { type: 'integer', notNull: true, unique: true },
        employee_number: { type: 'varchar(50)', notNull: true, unique: true },
        first_name: { type: 'varchar(100)', notNull: true },
        last_name: { type: 'varchar(100)', notNull: true },
        email: { type: 'varchar(255)', notNull: true, unique: true },
        phone: { type: 'varchar(50)' },
        department: { type: 'varchar(100)' },
        position: { type: 'varchar(200)' },
        employment_type: { type: 'varchar(50)', default: "'full_time'" },
        hire_date: { type: 'date', notNull: true },
        termination_date: { type: 'date' },
        status: { type: 'varchar(20)', notNull: true, default: "'active'" },
        salary: { type: 'numeric(12,2)' },
        currency: { type: 'varchar(3)', default: "'USD'" },
        location: { type: 'varchar(200)' },
        manager_id: { type: 'integer' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        deleted_at: { type: 'timestamptz' }
    });
    pgm.sql(
        `ALTER TABLE employees ADD CONSTRAINT chk_employees_status CHECK (status IN ('active','on_leave','terminated','resigned'))`
    );

    // ---- attendance ----
    pgm.createTable('attendance', {
        id: 'id',
        employee_id: { type: 'integer', notNull: true },
        date: { type: 'date', notNull: true },
        check_in: { type: 'timestamptz' },
        check_out: { type: 'timestamptz' },
        hours_worked: { type: 'numeric(5,2)' },
        status: { type: 'varchar(20)', notNull: true, default: "'present'" },
        notes: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });
    pgm.createIndex('attendance', ['employee_id', 'date'], { unique: true });

    // ---- leave_requests ----
    pgm.createTable('leave_requests', {
        id: 'id',
        employee_id: { type: 'integer', notNull: true },
        leave_type: { type: 'varchar(30)', notNull: true },
        start_date: { type: 'date', notNull: true },
        end_date: { type: 'date', notNull: true },
        days: { type: 'numeric(5,1)', notNull: true },
        reason: { type: 'text' },
        status: { type: 'varchar(20)', notNull: true, default: "'pending'" },
        approved_by: { type: 'integer' },
        approved_at: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    // ---- performance_reviews ----
    pgm.createTable('performance_reviews', {
        id: 'id',
        employee_id: { type: 'integer', notNull: true },
        review_period: { type: 'varchar(50)', notNull: true },
        reviewer_id: { type: 'integer', notNull: true },
        rating: { type: 'integer', notNull: true },
        goals: { type: 'text' },
        achievements: { type: 'text' },
        feedback: { type: 'text' },
        recommendations: { type: 'text' },
        status: { type: 'varchar(20)', notNull: true, default: "'draft'" },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    // ---- training_programs ----
    pgm.createTable('training_programs', {
        id: 'id',
        title: { type: 'varchar(200)', notNull: true },
        description: { type: 'text' },
        category: { type: 'varchar(100)' },
        provider: { type: 'varchar(200)' },
        duration_hours: { type: 'numeric(5,1)' },
        start_date: { type: 'date' },
        end_date: { type: 'date' },
        status: { type: 'varchar(20)', notNull: true, default: "'available'" },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        deleted_at: { type: 'timestamptz' }
    });

    pgm.createTable('training_enrollments', {
        id: 'id',
        program_id: { type: 'integer', notNull: true },
        employee_id: { type: 'integer', notNull: true },
        status: { type: 'varchar(20)', notNull: true, default: "'enrolled'" },
        progress: { type: 'numeric(5,2)', default: '0' },
        completed_at: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });
    pgm.createIndex('training_enrollments', ['program_id', 'employee_id'], { unique: true });

    // ---- payroll ----
    pgm.createTable('payroll_records', {
        id: 'id',
        employee_id: { type: 'integer', notNull: true },
        pay_period: { type: 'varchar(20)', notNull: true },
        pay_date: { type: 'date', notNull: true },
        gross_salary: { type: 'numeric(12,2)', notNull: true },
        deductions: { type: 'numeric(12,2)', default: '0' },
        tax: { type: 'numeric(12,2)', default: '0' },
        net_salary: { type: 'numeric(12,2)', notNull: true },
        bonus: { type: 'numeric(12,2)', default: '0' },
        currency: { type: 'varchar(3)', default: "'USD'" },
        status: { type: 'varchar(20)', notNull: true, default: "'pending'" },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });

    // ---- benefits ----
    pgm.createTable('benefit_plans', {
        id: 'id',
        name: { type: 'varchar(200)', notNull: true },
        description: { type: 'text' },
        category: { type: 'varchar(100)' },
        provider: { type: 'varchar(200)' },
        cost: { type: 'numeric(12,2)' },
        currency: { type: 'varchar(3)', default: "'USD'" },
        status: { type: 'varchar(20)', notNull: true, default: "'active'" },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        deleted_at: { type: 'timestamptz' }
    });

    pgm.createTable('employee_benefits', {
        id: 'id',
        employee_id: { type: 'integer', notNull: true },
        benefit_plan_id: { type: 'integer', notNull: true },
        enrollment_date: { type: 'date', notNull: true, default: pgm.func('current_date') },
        status: { type: 'varchar(20)', notNull: true, default: "'active'" },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    });
    pgm.createIndex('employee_benefits', ['employee_id', 'benefit_plan_id'], { unique: true });

    // updated_at triggers
    for (const tbl of [
        'employees',
        'attendance',
        'leave_requests',
        'performance_reviews',
        'training_programs',
        'training_enrollments',
        'payroll_records',
        'benefit_plans',
        'employee_benefits'
    ]) {
        pgm.sql(`
            CREATE TRIGGER trg_${tbl}_updated_at
            BEFORE UPDATE ON ${tbl}
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        `);
    }
};

exports.down = (pgm) => {
    for (const tbl of [
        'employee_benefits',
        'benefit_plans',
        'payroll_records',
        'training_enrollments',
        'training_programs',
        'performance_reviews',
        'leave_requests',
        'attendance',
        'employees'
    ]) {
        pgm.dropTable(tbl, { ifExists: true });
    }
};
