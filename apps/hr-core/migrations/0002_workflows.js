/**
 * 0002_workflows — interdepartmental onboarding/offboarding workflows +
 * transactional outbox (database: strafor_hr).
 *
 *   outbox_events           domain events inserted in the business tx and
 *                           delivered post-commit (sweeper retries).
 *   workflow_templates      named onboarding|offboarding checklists.
 *   workflow_template_tasks per-template tasks: owning department, optional
 *                           assignee (role name or user id), offset_days
 *                           relative to the workflow start_date, required
 *                           flag and sort_order.
 *   employee_workflows      a running workflow instance per employee. At
 *                           most one ACTIVE workflow per (employee, kind).
 *   employee_workflow_tasks task instances generated from the template on
 *                           start — status machine
 *                           pending|in_progress|done|skipped|blocked.
 *
 * A default MX onboarding template is seeded (IT cuentas/equipo, RH
 * contrato/expediente, Finanzas nómina, Facilities acceso a sede).
 */
exports.up = (pgm) => {
    pgm.sql(`
        -- Transactional outbox: domain events are inserted in the same tx as
        -- the business write and published post-commit (sweeper retries).
        CREATE TABLE outbox_events (
            id BIGSERIAL PRIMARY KEY,
            type VARCHAR(120) NOT NULL,
            payload JSONB NOT NULL,
            correlation_id VARCHAR(128),
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            published_at TIMESTAMPTZ,
            attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX outbox_events_pending_idx
            ON outbox_events (id) WHERE published_at IS NULL;

        CREATE TABLE workflow_templates (
            id BIGSERIAL PRIMARY KEY,
            kind VARCHAR(20) NOT NULL CHECK (kind IN ('onboarding','offboarding')),
            name VARCHAR(200) NOT NULL,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX workflow_templates_name_uidx
            ON workflow_templates (kind, name);

        CREATE TABLE workflow_template_tasks (
            id BIGSERIAL PRIMARY KEY,
            template_id BIGINT NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
            title VARCHAR(300) NOT NULL,
            description TEXT,
            department VARCHAR(20) NOT NULL DEFAULT 'other'
                CHECK (department IN ('it','hr','finance','facilities','legal','other')),
            -- Role name ('it', 'hr', ...) or a numeric user id as text.
            assignee_role_or_user VARCHAR(100),
            -- due_at = workflow start_date + offset_days.
            offset_days INTEGER NOT NULL DEFAULT 0,
            required BOOLEAN NOT NULL DEFAULT true,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX workflow_template_tasks_template_idx
            ON workflow_template_tasks (template_id, sort_order, id);

        CREATE TABLE employee_workflows (
            id BIGSERIAL PRIMARY KEY,
            employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            template_id BIGINT REFERENCES workflow_templates(id) ON DELETE SET NULL,
            kind VARCHAR(20) NOT NULL CHECK (kind IN ('onboarding','offboarding')),
            status VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','completed','cancelled')),
            start_date DATE NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            completed_at TIMESTAMPTZ,
            started_by INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX employee_workflows_employee_idx ON employee_workflows (employee_id);
        CREATE INDEX employee_workflows_status_idx ON employee_workflows (status);
        -- At most one active workflow per employee+kind.
        CREATE UNIQUE INDEX employee_workflows_live_uidx
            ON employee_workflows (employee_id, kind) WHERE status = 'active';

        CREATE TABLE employee_workflow_tasks (
            id BIGSERIAL PRIMARY KEY,
            workflow_id BIGINT NOT NULL REFERENCES employee_workflows(id) ON DELETE CASCADE,
            title VARCHAR(300) NOT NULL,
            description TEXT,
            department VARCHAR(20) NOT NULL DEFAULT 'other'
                CHECK (department IN ('it','hr','finance','facilities','legal','other')),
            assignee_user_id INTEGER,
            required BOOLEAN NOT NULL DEFAULT true,
            sort_order INTEGER NOT NULL DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','in_progress','done','skipped','blocked')),
            due_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            completed_by INTEGER,
            status_reason TEXT,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX employee_workflow_tasks_workflow_idx
            ON employee_workflow_tasks (workflow_id, sort_order, id);
        CREATE INDEX employee_workflow_tasks_assignee_idx
            ON employee_workflow_tasks (assignee_user_id)
            WHERE status IN ('pending','in_progress','blocked');
        CREATE INDEX employee_workflow_tasks_department_idx
            ON employee_workflow_tasks (department);
    `);

    // Seed: default MX onboarding template (idempotent only on fresh DBs —
    // the unique (kind, name) index makes re-runs fail loudly, which is the
    // desired behaviour for a seed).
    pgm.sql(`
        WITH t AS (
            INSERT INTO workflow_templates (kind, name, active)
            VALUES ('onboarding', 'Onboarding MX (default)', true)
            RETURNING id
        )
        INSERT INTO workflow_template_tasks
            (template_id, title, description, department, assignee_role_or_user, offset_days, required, sort_order)
        SELECT t.id, x.title, x.description, x.department, x.assignee, x.offset_days, x.required, x.sort_order
        FROM t
        CROSS JOIN (VALUES
            ('Crear cuentas de acceso (correo, VPN, sistemas)',
             'Alta de identidad digital y accesos a sistemas internos', 'it', 'it', 0, true, 10),
            ('Asignar equipo de cómputo',
             'Entrega de laptop y periféricos al nuevo ingreso', 'it', 'it', 1, true, 20),
            ('Contrato de trabajo firmado',
             'Recabar la firma del contrato individual de trabajo', 'hr', 'hr', 0, true, 30),
            ('Integrar expediente del empleado',
             'Expediente completo: identificación, comprobante de domicilio, RFC, CURP, NSS', 'hr', 'hr', 3, true, 40),
            ('Alta en nómina',
             'Registro del empleado en el sistema de nómina', 'finance', 'finance', 2, true, 50),
            ('Credencial y acceso a sede',
             'Credencial de acceso y presentación de la sede asignada', 'facilities', 'facilities', 1, false, 60)
        ) AS x(title, description, department, assignee, offset_days, required, sort_order);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE employee_workflow_tasks;
        DROP TABLE employee_workflows;
        DROP TABLE workflow_template_tasks;
        DROP TABLE workflow_templates;
        DROP TABLE outbox_events;
    `);
};
