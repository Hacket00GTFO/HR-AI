/**
 * 0001_time — time-attendance service schema (database: strafor_time).
 *
 *   work_schedules         configurable schedule templates (fixed/flexible/shift)
 *   employee_schedules     employee → schedule assignments with validity window.
 *                          employee_id references hr-core employees — plain
 *                          INTEGER, NO cross-database FK per service-DB contract.
 *   attendance_events      append-only point-in-time events (check-in/out,
 *                          breaks). Geolocation is stored ONLY when the
 *                          employee explicitly consented for that event
 *                          (geo_consent=true) — enforced by CHECK constraint.
 *                          There is NO continuous tracking anywhere: only the
 *                          coordinates attached to a punch are persisted.
 *   attendance_corrections the ONLY way events change — approval flow,
 *                          never direct edits by clients.
 *   leave_types            seeded with MX statutory types (LFT): vacaciones,
 *                          incapacidad, permiso, maternidad, paternidad.
 *   leave_requests         approval workflow (pending/approved/rejected/cancelled)
 *   leave_balances         per (employee, type, year) entitled/used/carried.
 */

// MX statutory vacation entitlement — Ley Federal del Trabajo art. 76
// (reforma "vacaciones dignas", en vigor desde 2023-01-01):
//   year 1 → 12 días, +2 días por año hasta 20 (año 5),
//   luego +2 días por cada 5 años de servicio.
const MX_VACATION_ACCRUAL = JSON.stringify({
    jurisdiction: 'MX',
    statute: 'LFT-76',
    unit: 'days',
    description: '12 días el primer año; +2 por año hasta 20; después +2 por cada 5 años de servicio',
    table: [
        { minYears: 1, maxYears: 1, days: 12 },
        { minYears: 2, maxYears: 2, days: 14 },
        { minYears: 3, maxYears: 3, days: 16 },
        { minYears: 4, maxYears: 4, days: 18 },
        { minYears: 5, maxYears: 5, days: 20 },
        { minYears: 6, maxYears: 10, days: 22 },
        { minYears: 11, maxYears: 15, days: 24 },
        { minYears: 16, maxYears: 20, days: 26 },
        { minYears: 21, maxYears: 25, days: 28 },
        { minYears: 26, maxYears: 30, days: 30 },
        { minYears: 31, maxYears: 35, days: 32 }
    ]
});

exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE work_schedules (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            type VARCHAR(20) NOT NULL CHECK (type IN ('fixed', 'flexible', 'shift')),
            weekly_hours NUMERIC(5, 2) NOT NULL CHECK (weekly_hours > 0 AND weekly_hours <= 84),
            -- type-specific shape: fixed → {workdays, startTime, endTime, breakMinutes},
            -- flexible → {coreHours, windowStart, windowEnd},
            -- shift → {rotation: [{name, startTime, endTime, days}]}
            config JSONB NOT NULL DEFAULT '{}',
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE employee_schedules (
            id BIGSERIAL PRIMARY KEY,
            employee_id INTEGER NOT NULL,
            schedule_id BIGINT NOT NULL REFERENCES work_schedules(id) ON DELETE CASCADE,
            effective_from DATE NOT NULL,
            effective_to DATE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (effective_to IS NULL OR effective_to >= effective_from)
        );
        -- At most one open-ended assignment per employee.
        CREATE UNIQUE INDEX employee_schedules_open_uidx
            ON employee_schedules (employee_id) WHERE effective_to IS NULL;
        CREATE INDEX employee_schedules_emp_idx ON employee_schedules (employee_id);
        CREATE INDEX employee_schedules_sched_idx ON employee_schedules (schedule_id);

        CREATE TABLE attendance_events (
            id BIGSERIAL PRIMARY KEY,
            employee_id INTEGER NOT NULL,
            kind VARCHAR(20) NOT NULL
                CHECK (kind IN ('check_in', 'check_out', 'break_start', 'break_end')),
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            geo_lat NUMERIC(9, 6),
            geo_lng NUMERIC(9, 6),
            geo_accuracy_m INTEGER,
            geo_consent BOOLEAN NOT NULL DEFAULT false,
            source VARCHAR(20) NOT NULL DEFAULT 'pwa'
                CHECK (source IN ('pwa', 'manual', 'correction')),
            -- user id that recorded the event (self-service punch or HR actor)
            created_by INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            -- Point-in-time geo only: both coordinates or neither, and consent
            -- is mandatory whenever coordinates are stored.
            CHECK ((geo_lat IS NULL) = (geo_lng IS NULL)),
            CHECK (geo_lat IS NULL OR geo_consent = true)
        );
        CREATE INDEX attendance_events_emp_time_idx
            ON attendance_events (employee_id, occurred_at DESC);
        CREATE INDEX attendance_events_kind_idx
            ON attendance_events (employee_id, kind, occurred_at DESC);

        CREATE TABLE attendance_corrections (
            id BIGSERIAL PRIMARY KEY,
            event_id BIGINT NOT NULL REFERENCES attendance_events(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL,
            requested_by INTEGER NOT NULL,
            field VARCHAR(40) NOT NULL CHECK (field IN ('occurred_at', 'kind', 'geo')),
            old_value JSONB,
            new_value JSONB NOT NULL,
            reason TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
            reviewed_by INTEGER,
            reviewed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX attendance_corrections_pending_idx
            ON attendance_corrections (created_at) WHERE status = 'pending';
        CREATE INDEX attendance_corrections_emp_idx
            ON attendance_corrections (employee_id);

        CREATE TABLE leave_types (
            id BIGSERIAL PRIMARY KEY,
            code VARCHAR(40) NOT NULL UNIQUE,
            name VARCHAR(120) NOT NULL,
            paid BOOLEAN NOT NULL DEFAULT true,
            requires_approval BOOLEAN NOT NULL DEFAULT true,
            -- accrual rule; see MX_VACATION_ACCRUAL for the table shape
            accrual JSONB NOT NULL DEFAULT '{}'
        );

        CREATE TABLE leave_requests (
            id BIGSERIAL PRIMARY KEY,
            employee_id INTEGER NOT NULL,
            leave_type_id BIGINT NOT NULL REFERENCES leave_types(id),
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            days NUMERIC(6, 2) NOT NULL CHECK (days > 0),
            status VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
            approver_id INTEGER,
            reason TEXT,
            decided_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (end_date >= start_date)
        );
        CREATE INDEX leave_requests_emp_idx ON leave_requests (employee_id, status);
        CREATE INDEX leave_requests_status_idx ON leave_requests (status);

        CREATE TABLE leave_balances (
            id BIGSERIAL PRIMARY KEY,
            employee_id INTEGER NOT NULL,
            leave_type_id BIGINT NOT NULL REFERENCES leave_types(id),
            year INTEGER NOT NULL,
            entitled NUMERIC(6, 2) NOT NULL DEFAULT 0,
            used NUMERIC(6, 2) NOT NULL DEFAULT 0,
            carried NUMERIC(6, 2) NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (employee_id, leave_type_id, year)
        );

        -- MX statutory leave types (Ley Federal del Trabajo).
        INSERT INTO leave_types (code, name, paid, requires_approval, accrual) VALUES
            ('vacaciones', 'Vacaciones (LFT art. 76)', true, true, '${MX_VACATION_ACCRUAL}'::jsonb),
            ('incapacidad', 'Incapacidad (IMSS/LFT)', true, false, '{}'::jsonb),
            ('permiso', 'Permiso con/sin goce', false, true, '{}'::jsonb),
            ('maternidad', 'Maternidad (LFT art. 170 — 84 días)', true, false, '{}'::jsonb),
            ('paternidad', 'Paternidad (LFT art. 170 — 5 días)', true, false, '{}'::jsonb);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE leave_balances;
        DROP TABLE leave_requests;
        DROP TABLE leave_types;
        DROP TABLE attendance_corrections;
        DROP TABLE attendance_events;
        DROP TABLE employee_schedules;
        DROP TABLE work_schedules;
    `);
};
