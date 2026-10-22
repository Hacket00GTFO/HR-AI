/**
 * 0001_hr_services — hr-services schema (database: strafor_services).
 *
 *   employee_directory     — minimal read-model of hr-core employees used to
 *                            resolve a gateway user (user_id) to an
 *                            employee_id for self-service scoping, and to
 *                            bucket survey respondents into groups
 *                            (department) for aggregation. Fed exclusively by
 *                            service-token upserts on
 *                            /v1/internal/employee-directory. NO cross-db FK.
 *   tickets                — HR service desk (mesa de servicio).
 *   ticket_comments        — employee + HR comments on tickets.
 *   ticket_status_history  — every status transition, incl. creation.
 *   assets                 — company assets (activos) by inventory tag.
 *   asset_assignments      — checkout/checkin ledger with condition notes.
 *   expense_reports        — viaticos reports; `total` is server-computed
 *                            from expense_items and maintained on write.
 *   expense_items          — report line items; receipt_doc_id is a plain
 *                            UUID reference to documents-resumes (no FK).
 *   expense_approvals      — approve/reject decisions (HR).
 *   surveys                — NOM-035 / climate surveys.
 *   survey_questions       — per-dimension questions, 1..scale. Questions
 *                            flagged health_related (medical risk factors /
 *                            psicosocial) have their answers stored
 *                            SEPARATELY in survey_health_answers.
 *   survey_responses       — one response per employee per survey. The
 *                            respondent is pseudonymised: respondent_hash =
 *                            HMAC-SHA256(survey salt, surveyId:employeeId).
 *                            Raw employee_id is NEVER stored. Answers to
 *                            non-health questions live in `answers`.
 *   survey_health_answers  — health-related answers, isolated table.
 *   survey_health_audit    — audit trail: every read/write of
 *                            survey_health_answers appends a row.
 *   survey_results_agg     — per-(group, dimension) averages computed when a
 *                            survey closes. Cells with fewer respondents
 *                            than the k-anonymity threshold are stored with
 *                            suppressed=true and NULL avg_score.
 *   outbox_events          — transactional outbox for domain events; rows
 *                            are written inside the business tx and
 *                            published by the service/sweeper.
 *
 * Individual survey_responses rows are NEVER exposed via the API — only
 * aggregates with k >= SURVEY_MIN_GROUP_SIZE (default 5).
 */
exports.up = (pgm) => {
    pgm.sql(`
        -- Read-model of hr-core employees for self-service scoping and
        -- survey grouping; populated via service-token upserts.
        CREATE TABLE employee_directory (
            id BIGINT PRIMARY KEY,             -- hr-core employee id
            user_id INTEGER NOT NULL,          -- identity-auth user id
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            department VARCHAR(100),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX employee_directory_user_uidx
            ON employee_directory (user_id);
        CREATE INDEX employee_directory_department_idx
            ON employee_directory (department);

        CREATE TABLE tickets (
            id BIGSERIAL PRIMARY KEY,
            employee_id BIGINT NOT NULL,
            category VARCHAR(60) NOT NULL DEFAULT 'general',
            subject VARCHAR(300) NOT NULL,
            description TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','assigned','in_progress','waiting_employee','resolved','closed')),
            priority VARCHAR(10) NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('critical','high','normal','low')),
            assignee_user_id INTEGER,
            sla_due_at TIMESTAMPTZ,
            resolved_at TIMESTAMPTZ,
            closed_at TIMESTAMPTZ,
            created_by_user_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX tickets_employee_idx ON tickets (employee_id);
        CREATE INDEX tickets_status_idx ON tickets (status);
        CREATE INDEX tickets_assignee_idx
            ON tickets (assignee_user_id) WHERE assignee_user_id IS NOT NULL;
        CREATE INDEX tickets_sla_idx
            ON tickets (sla_due_at) WHERE status NOT IN ('resolved','closed');

        CREATE TABLE ticket_comments (
            id BIGSERIAL PRIMARY KEY,
            ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            author_user_id INTEGER NOT NULL,
            author_kind VARCHAR(10) NOT NULL CHECK (author_kind IN ('employee','hr')),
            body TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX ticket_comments_ticket_idx ON ticket_comments (ticket_id);

        CREATE TABLE ticket_status_history (
            id BIGSERIAL PRIMARY KEY,
            ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            from_status VARCHAR(20),
            to_status VARCHAR(20) NOT NULL,
            changed_by INTEGER,
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX ticket_status_history_ticket_idx
            ON ticket_status_history (ticket_id);

        CREATE TABLE assets (
            id BIGSERIAL PRIMARY KEY,
            tag VARCHAR(80) NOT NULL,
            type VARCHAR(60) NOT NULL DEFAULT 'other',
            serial VARCHAR(120),
            description VARCHAR(300),
            status VARCHAR(15) NOT NULL DEFAULT 'available'
                CHECK (status IN ('available','assigned','maintenance','retired')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX assets_tag_uidx ON assets (tag);
        CREATE INDEX assets_status_idx ON assets (status);
        CREATE INDEX assets_type_idx ON assets (type);

        CREATE TABLE asset_assignments (
            id BIGSERIAL PRIMARY KEY,
            asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            employee_id BIGINT NOT NULL,
            assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            returned_at TIMESTAMPTZ,
            condition_out TEXT,
            condition_in TEXT,
            assigned_by INTEGER,
            returned_by INTEGER
        );
        CREATE INDEX asset_assignments_asset_idx ON asset_assignments (asset_id);
        CREATE INDEX asset_assignments_employee_idx ON asset_assignments (employee_id);
        -- At most one open assignment per asset.
        CREATE UNIQUE INDEX asset_assignments_open_uidx
            ON asset_assignments (asset_id) WHERE returned_at IS NULL;

        CREATE TABLE expense_reports (
            id BIGSERIAL PRIMARY KEY,
            employee_id BIGINT NOT NULL,
            title VARCHAR(300) NOT NULL,
            status VARCHAR(12) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','submitted','approved','rejected','paid')),
            currency CHAR(3) NOT NULL DEFAULT 'MXN',
            total NUMERIC(12,2) NOT NULL DEFAULT 0,
            submitted_at TIMESTAMPTZ,
            decided_at TIMESTAMPTZ,
            paid_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX expense_reports_employee_idx ON expense_reports (employee_id);
        CREATE INDEX expense_reports_status_idx ON expense_reports (status);

        CREATE TABLE expense_items (
            id BIGSERIAL PRIMARY KEY,
            report_id BIGINT NOT NULL REFERENCES expense_reports(id) ON DELETE CASCADE,
            item_date DATE NOT NULL,
            category VARCHAR(60) NOT NULL DEFAULT 'other',
            amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
            description VARCHAR(500),
            receipt_doc_id UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX expense_items_report_idx ON expense_items (report_id);

        CREATE TABLE expense_approvals (
            id BIGSERIAL PRIMARY KEY,
            report_id BIGINT NOT NULL REFERENCES expense_reports(id) ON DELETE CASCADE,
            approver_user_id INTEGER,
            decision VARCHAR(10) NOT NULL CHECK (decision IN ('approved','rejected')),
            comment TEXT,
            decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX expense_approvals_report_idx ON expense_approvals (report_id);

        CREATE TABLE surveys (
            id BIGSERIAL PRIMARY KEY,
            title VARCHAR(300) NOT NULL,
            type VARCHAR(10) NOT NULL CHECK (type IN ('nom035','climate')),
            status VARCHAR(10) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','open','closed')),
            opens_at TIMESTAMPTZ,
            closes_at TIMESTAMPTZ,
            created_by INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX surveys_status_idx ON surveys (status);

        CREATE TABLE survey_questions (
            id BIGSERIAL PRIMARY KEY,
            survey_id BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
            dimension VARCHAR(100) NOT NULL,
            text TEXT NOT NULL,
            scale INTEGER NOT NULL DEFAULT 5 CHECK (scale BETWEEN 2 AND 10),
            health_related BOOLEAN NOT NULL DEFAULT false,
            position INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX survey_questions_survey_idx ON survey_questions (survey_id);

        -- respondent_hash = HMAC-SHA256(salt, '<surveyId>:<employeeId>').
        -- The raw employee_id is never persisted for survey responses.
        CREATE TABLE survey_responses (
            id BIGSERIAL PRIMARY KEY,
            survey_id BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
            respondent_hash CHAR(64) NOT NULL,
            respondent_group VARCHAR(100),
            answers JSONB NOT NULL DEFAULT '{}',
            submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX survey_responses_unique_uidx
            ON survey_responses (survey_id, respondent_hash);
        CREATE INDEX survey_responses_survey_idx ON survey_responses (survey_id);

        -- Health-related answers (medical risk factors / psicosocial) live
        -- apart from the rest; EVERY read/write must append to
        -- survey_health_audit.
        CREATE TABLE survey_health_answers (
            id BIGSERIAL PRIMARY KEY,
            response_id BIGINT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
            answers JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX survey_health_answers_response_uidx
            ON survey_health_answers (response_id);

        CREATE TABLE survey_health_audit (
            id BIGSERIAL PRIMARY KEY,
            response_id BIGINT,
            action VARCHAR(10) NOT NULL CHECK (action IN ('read','write')),
            actor VARCHAR(80) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX survey_health_audit_response_idx
            ON survey_health_audit (response_id);

        -- Pre-computed, k-anonymised aggregates. Cells under the threshold
        -- are stored suppressed (avg_score NULL, respondents still shown so
        -- consumers can display 'n<k').
        CREATE TABLE survey_results_agg (
            id BIGSERIAL PRIMARY KEY,
            survey_id BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
            respondent_group VARCHAR(100) NOT NULL DEFAULT '_all',
            dimension VARCHAR(100) NOT NULL,
            respondents INTEGER NOT NULL,
            avg_score NUMERIC(6,3),
            suppressed BOOLEAN NOT NULL DEFAULT false,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (survey_id, respondent_group, dimension)
        );

        -- Transactional outbox for domain events (strafor.services.*).
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
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE outbox_events;
        DROP TABLE survey_results_agg;
        DROP TABLE survey_health_audit;
        DROP TABLE survey_health_answers;
        DROP TABLE survey_responses;
        DROP TABLE survey_questions;
        DROP TABLE surveys;
        DROP TABLE expense_approvals;
        DROP TABLE expense_items;
        DROP TABLE expense_reports;
        DROP TABLE asset_assignments;
        DROP TABLE assets;
        DROP TABLE ticket_status_history;
        DROP TABLE ticket_comments;
        DROP TABLE tickets;
        DROP TABLE employee_directory;
    `);
};
