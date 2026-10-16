/**
 * 0024_employees_mx — employees table adjustments for the Mexico-first HRM:
 *  - user_id becomes nullable: an employee record precedes account
 *    provisioning (the login account is created later via identity-auth).
 *  - currency defaults to MXN (Mexico-first deployment).
 *  - Mexican legal/organizational fields: RFC, CURP, NSS, legal_entity
 *    (razón social), site (sede).
 */
exports.up = (pgm) => {
    pgm.alterColumn('employees', 'user_id', { notNull: false });

    pgm.alterColumn('employees', 'currency', { default: 'MXN' });
    pgm.alterColumn('payroll_records', 'currency', { default: 'MXN' });
    pgm.alterColumn('benefit_plans', 'currency', { default: 'MXN' });

    pgm.addColumns('employees', {
        rfc: { type: 'varchar(13)' },
        curp: { type: 'varchar(18)' },
        nss: { type: 'varchar(11)' },
        legal_entity: { type: 'varchar(200)' },
        site: { type: 'varchar(100)' }
    });
    pgm.createIndex('employees', 'legal_entity');
    pgm.createIndex('employees', 'site');
};

exports.down = (pgm) => {
    pgm.dropIndex('employees', 'legal_entity', { ifExists: true });
    pgm.dropIndex('employees', 'site', { ifExists: true });
    pgm.dropColumns('employees', ['rfc', 'curp', 'nss', 'legal_entity', 'site']);
    pgm.alterColumn('benefit_plans', 'currency', { default: 'USD' });
    pgm.alterColumn('payroll_records', 'currency', { default: 'USD' });
    pgm.alterColumn('employees', 'currency', { default: 'USD' });
    // Fails if NULLs were introduced — intentional: backfill before rollback.
    pgm.alterColumn('employees', 'user_id', { notNull: true });
};
