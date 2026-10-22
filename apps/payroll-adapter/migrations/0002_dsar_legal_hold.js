/**
 * 0002_dsar_legal_hold — DSAR erasure support on employee_fiscal_mx.
 *
 * Mexican fiscal/ labour law (CFF art. 30 — 5-year retention; LFT/IMSS
 * payroll record duties) requires payroll data to be RETAINED even when a
 * data subject exercises erasure. The /v1/internal/dsar-erase endpoint
 * therefore PSEUDONYMISES the identifying fiscal columns (rfc/curp/nss/
 * clabe/bank_code → NULL) instead of deleting the row, and flags it
 * legal_hold=true so downstream tooling knows the row was subject-erased
 * but is retained under statutory obligation.
 *
 * payroll_items / payroll_reconciliations keep their amounts and employee_id
 * — they are financial records covered by the same retention duty; the
 * employee_id becomes non-identifying once hr-core pseudonymises the person.
 */
exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE employee_fiscal_mx
            ADD COLUMN legal_hold BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN erased_at TIMESTAMPTZ;
        COMMENT ON COLUMN employee_fiscal_mx.legal_hold IS
            'DSAR: row was pseudonymised for an erasure request but retained '
            'under MX statutory fiscal/labour retention duties.';
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        ALTER TABLE employee_fiscal_mx
            DROP COLUMN legal_hold,
            DROP COLUMN erased_at;
    `);
};
