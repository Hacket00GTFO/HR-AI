/**
 * 0001_payroll — payroll-adapter service schema (Mexico).
 *
 * Adapter-first design: payroll is never computed natively. External provider
 * results are imported into payroll_items (raw payloads retained for audit),
 * moved through a strict period lifecycle, and compared against expected
 * values in shadow mode via payroll_reconciliations before finalization.
 *
 *   employee_fiscal_mx       RFC/CURP/NSS/CLABE in its OWN table — never merged
 *                            into employee records; every access is audited.
 *   payroll_periods          lifecycle state machine (catorcenal/mensual)
 *   payroll_items            imported provider line items (idempotent on
 *                            (period_id, provider_ref))
 *   payroll_exports          generated file registry (provider_import,
 *                            bank_disperse, receipts, reconcile)
 *   payroll_reconciliations  shadow-mode expected-vs-actual diff rows
 *   payroll_providers        adapter registry (file_generic, sandbox_stub)
 *   payroll_audit            every mutation + every fiscal read/write
 */
exports.up = (pgm) => {
    pgm.sql(`
        CREATE TABLE employee_fiscal_mx (
            id BIGSERIAL PRIMARY KEY,
            employee_id INTEGER NOT NULL UNIQUE,
            rfc VARCHAR(13),
            curp VARCHAR(18),
            nss VARCHAR(11),
            clabe VARCHAR(18),
            bank_code VARCHAR(10),
            legal_entity VARCHAR(200),
            regime VARCHAR(60),
            contract_type VARCHAR(60),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE payroll_periods (
            id BIGSERIAL PRIMARY KEY,
            frequency VARCHAR(20) NOT NULL
                CHECK (frequency IN ('catorcenal', 'mensual')),
            period_start DATE NOT NULL,
            period_end DATE NOT NULL,
            legal_entity VARCHAR(200),
            status VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'calculating', 'review', 'locked',
                                  'exported', 'reconciled', 'finalized', 'cancelled')),
            created_by INTEGER,
            approved_by INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (period_end >= period_start)
        );
        CREATE INDEX payroll_periods_status_idx ON payroll_periods (status);

        CREATE TABLE payroll_items (
            id BIGSERIAL PRIMARY KEY,
            period_id BIGINT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL,
            provider VARCHAR(80) NOT NULL,
            gross NUMERIC(14, 2) NOT NULL DEFAULT 0,
            deductions JSONB NOT NULL DEFAULT '{}',
            net NUMERIC(14, 2) NOT NULL DEFAULT 0,
            provider_ref VARCHAR(200) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'imported',
            raw JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Import idempotency: re-importing the same provider_ref upserts.
        CREATE UNIQUE INDEX payroll_items_period_ref_uidx
            ON payroll_items (period_id, provider_ref);
        CREATE INDEX payroll_items_period_idx ON payroll_items (period_id);
        CREATE INDEX payroll_items_employee_idx ON payroll_items (employee_id);

        CREATE TABLE payroll_exports (
            id BIGSERIAL PRIMARY KEY,
            period_id BIGINT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
            kind VARCHAR(40) NOT NULL
                CHECK (kind IN ('provider_import', 'bank_disperse', 'receipts', 'reconcile')),
            format VARCHAR(20) NOT NULL DEFAULT 'csv',
            storage_ref VARCHAR(1024) NOT NULL,
            generated_by INTEGER,
            generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX payroll_exports_period_idx ON payroll_exports (period_id);

        CREATE TABLE payroll_reconciliations (
            id BIGSERIAL PRIMARY KEY,
            period_id BIGINT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL,
            field VARCHAR(40) NOT NULL,
            expected NUMERIC(14, 2),
            actual NUMERIC(14, 2),
            delta NUMERIC(14, 2),
            status VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'reviewed', 'resolved')),
            resolved_by INTEGER,
            resolved_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX payroll_recon_period_idx ON payroll_reconciliations (period_id);
        CREATE INDEX payroll_recon_status_idx ON payroll_reconciliations (status)
            WHERE status = 'pending';

        CREATE TABLE payroll_providers (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(80) NOT NULL UNIQUE,
            adapter VARCHAR(80) NOT NULL,
            config JSONB NOT NULL DEFAULT '{}',
            enabled BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE payroll_audit (
            id BIGSERIAL PRIMARY KEY,
            actor VARCHAR(120) NOT NULL,
            action VARCHAR(60) NOT NULL,
            entity VARCHAR(60) NOT NULL,
            entity_id VARCHAR(120),
            metadata JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX payroll_audit_entity_idx ON payroll_audit (entity, entity_id);
        CREATE INDEX payroll_audit_created_idx ON payroll_audit (created_at);

        -- Seeded adapters: file_generic is the real MVP import path;
        -- sandbox_stub produces deterministic fake results for dev/tests.
        INSERT INTO payroll_providers (name, adapter, config, enabled) VALUES
            ('file_generic', 'file_generic', '{}', true),
            ('sandbox_stub', 'sandbox_stub',
             '{"employees": [1], "baseGross": 15000}', false);
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP TABLE payroll_audit;
        DROP TABLE payroll_providers;
        DROP TABLE payroll_reconciliations;
        DROP TABLE payroll_exports;
        DROP TABLE payroll_items;
        DROP TABLE payroll_periods;
        DROP TABLE employee_fiscal_mx;
    `);
};
