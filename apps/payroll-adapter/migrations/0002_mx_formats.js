/**
 * 0002_mx_formats — Mexican payroll file-format support.
 *
 *   - employee_fiscal_mx.bank_name (and clabe, defensively IF NOT EXISTS) for
 *     CLABE-interbancaria dispersion files.
 *   - payroll_items.employee_id becomes nullable so unmatched provider lines
 *     (e.g. SUA NSS with no fiscal record) can be persisted with status
 *     'unmatched' while retaining their provider_ref.
 *   - payroll_exports.kind gains 'dispersion' for bank-dispersion files.
 *   - Seed (disabled) provider rows for the new adapters sua_file and
 *     bank_dispersion.
 */
exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE employee_fiscal_mx
            ADD COLUMN IF NOT EXISTS clabe VARCHAR(18),
            ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);

        ALTER TABLE payroll_items ALTER COLUMN employee_id DROP NOT NULL;

        ALTER TABLE payroll_exports DROP CONSTRAINT payroll_exports_kind_check;
        ALTER TABLE payroll_exports ADD CONSTRAINT payroll_exports_kind_check
            CHECK (kind IN ('provider_import', 'bank_disperse', 'receipts',
                            'reconcile', 'dispersion'));

        INSERT INTO payroll_providers (name, adapter, config, enabled) VALUES
            ('sua_file', 'sua_file', '{}', false),
            ('bank_dispersion', 'bank_dispersion',
             '{"rfc": "XAXX010101000"}', false)
        ON CONFLICT (name) DO NOTHING;
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DELETE FROM payroll_providers WHERE name IN ('sua_file', 'bank_dispersion');

        ALTER TABLE payroll_exports DROP CONSTRAINT payroll_exports_kind_check;
        ALTER TABLE payroll_exports ADD CONSTRAINT payroll_exports_kind_check
            CHECK (kind IN ('provider_import', 'bank_disperse', 'receipts', 'reconcile'));

        UPDATE payroll_items SET employee_id = 0 WHERE employee_id IS NULL;
        ALTER TABLE payroll_items ALTER COLUMN employee_id SET NOT NULL;

        ALTER TABLE employee_fiscal_mx DROP COLUMN IF EXISTS bank_name;
    `);
};
