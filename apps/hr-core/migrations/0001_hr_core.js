/**
 * 0001_hr_core — hr-core service schema (database: strafor_hr).
 *
 * Ported from the monolith's employees table (migrations 0011_hr_modules +
 * 0024_employees_mx) plus the org/onboarding foundation:
 *
 *   employees           full MX shape — nullable user_id (account is
 *                       provisioned later via identity-auth), rfc/curp/nss,
 *                       legal_entity, site, soft delete. `department` stays a
 *                       varchar for legacy compatibility; `department_id`
 *                       links to the structured departments table.
 *   departments         org units with parent_department_id hierarchy and an
 *                       optional head_employee_id.
 *   employee_documents  link table to documents-resumes documents — plain
 *                       UUID reference, NO cross-database FK.
 *   users_projection    minimal read-model of identity users for display
 *                       names (fed by service-token upserts / future events).
 *   onboarding_cases    onboarding/offboarding processes per employee.
 *   onboarding_tasks    interdepartmental checklist items with owner,
 *                       due date and a `blocking` flag.
 *
 * Unique constraints on employees are PARTIAL (live rows only) so a
 * soft-deleted employee does not block re-using number/email/user link.
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE employees (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER,
            employee_number VARCHAR(50) NOT NULL,
            first_name VARCHAR(100) NOT NULL,
            last_name VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL,
            phone VARCHAR(50),
            department VARCHAR(100),
            department_id BIGINT,
            position VARCHAR(200),
            employment_type VARCHAR(50) NOT NULL DEFAULT 'full_time',
            hire_date DATE NOT NULL,
            termination_date DATE,
            status VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('pending','active','on_leave','terminated','resigned')),
            salary NUMERIC(12,2),
            currency VARCHAR(3) NOT NULL DEFAULT 'MXN',
            location VARCHAR(200),
            manager_id BIGINT,
            -- Mexico-first legal fields (sensitive — hr role only)
            rfc VARCHAR(13),
            curp VARCHAR(18),
            nss VARCHAR(11),
            legal_entity VARCHAR(200),
            site VARCHAR(100),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        );

        CREATE UNIQUE INDEX employees_number_live_uidx
            ON employees (employee_number) WHERE deleted_at IS NULL;
        CREATE UNIQUE INDEX employees_email_live_uidx
            ON employees (email) WHERE deleted_at IS NULL;
        CREATE UNIQUE INDEX employees_user_live_uidx
            ON employees (user_id) WHERE deleted_at IS NULL AND user_id IS NOT NULL;
        CREATE INDEX employees_status_idx
            ON employees (status) WHERE deleted_at IS NULL;
        CREATE INDEX employees_legal_entity_idx ON employees (legal_entity);
        CREATE INDEX employees_site_idx ON employees (site);
        CREATE INDEX employees_department_id_idx
            ON employees (department_id) WHERE deleted_at IS NULL;
        CREATE INDEX employees_manager_idx
            ON employees (manager_id) WHERE deleted_at IS NULL;

        CREATE TABLE departments (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(200) NOT NULL,
            code VARCHAR(50),
            description TEXT,
            parent_department_id BIGINT REFERENCES departments(id) ON DELETE SET NULL,
            head_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
            location VARCHAR(200),
            cost_center VARCHAR(50),
            status VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','inactive')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX departments_name_live_uidx
            ON departments (name) WHERE deleted_at IS NULL;
        CREATE INDEX departments_parent_idx
            ON departments (parent_department_id) WHERE deleted_at IS NULL;
        CREATE INDEX departments_head_idx ON departments (head_employee_id);

        ALTER TABLE employees
            ADD CONSTRAINT employees_department_fk
            FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;

        ALTER TABLE employees
            ADD CONSTRAINT employees_manager_fk
            FOREIGN KEY (manager_id) REFERENCES employees(id) ON DELETE SET NULL;

        -- Link to documents-resumes documents. document_id is a plain UUID —
        -- no cross-database FK per the service-DB contract.
        CREATE TABLE employee_documents (
            id BIGSERIAL PRIMARY KEY,
            employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            document_id UUID NOT NULL,
            kind VARCHAR(60) NOT NULL DEFAULT 'other',
            uploaded_by INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX employee_documents_doc_uidx
            ON employee_documents (document_id);
        CREATE INDEX employee_documents_employee_idx
            ON employee_documents (employee_id);

        -- Read-model of identity users for display names; populated via the
        -- service-token upsert endpoint (event consumer can come later).
        CREATE TABLE users_projection (
            id INTEGER PRIMARY KEY,
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE onboarding_cases (
            id BIGSERIAL PRIMARY KEY,
            employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            type VARCHAR(20) NOT NULL CHECK (type IN ('onboarding','offboarding')),
            status VARCHAR(20) NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_progress','blocked','completed','cancelled')),
            started_by INTEGER,
            due_date DATE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX onboarding_cases_employee_idx ON onboarding_cases (employee_id);
        CREATE INDEX onboarding_cases_status_idx ON onboarding_cases (status);
        -- At most one live case per employee+type.
        CREATE UNIQUE INDEX onboarding_cases_live_uidx
            ON onboarding_cases (employee_id, type)
            WHERE status IN ('open','in_progress','blocked');

        CREATE TABLE onboarding_tasks (
            id BIGSERIAL PRIMARY KEY,
            case_id BIGINT NOT NULL REFERENCES onboarding_cases(id) ON DELETE CASCADE,
            title VARCHAR(300) NOT NULL,
            department VARCHAR(100),
            owner_user_id INTEGER,
            status VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','in_progress','done','blocked')),
            due_date DATE,
            completed_at TIMESTAMPTZ,
            blocking BOOLEAN NOT NULL DEFAULT false,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX onboarding_tasks_case_idx ON onboarding_tasks (case_id);
        CREATE INDEX onboarding_tasks_owner_idx
            ON onboarding_tasks (owner_user_id) WHERE status <> 'done';
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE onboarding_tasks;
        DROP TABLE onboarding_cases;
        DROP TABLE users_projection;
        DROP TABLE employee_documents;
        ALTER TABLE employees DROP CONSTRAINT employees_department_fk;
        ALTER TABLE employees DROP CONSTRAINT employees_manager_fk;
        DROP TABLE departments;
        DROP TABLE employees;
    `);
};
