const { z } = require('zod');
const { eventEnvelope } = require('./base');

// HR-domain events emitted by the hr-core service.
//
// Type strings use `strafor.hr.employee_*` (snake_case suffix) per the
// extraction spec. Payloads carry identifiers only — sensitive fields
// (rfc/curp/nss/salary) are never published on the bus.

const EMPLOYEE_STATUSES = ['pending', 'active', 'on_leave', 'terminated', 'resigned'];

const employeeRef = {
    employeeId: z.number().int().positive(),
    employeeNumber: z.string().min(1)
};

// POST /v1/employees created a record.
const EmployeeCreated = eventEnvelope(
    'strafor.hr.employee_created',
    1,
    z
        .object({
            ...employeeRef,
            // Nullable: the login account is provisioned later via identity-auth.
            userId: z.number().int().positive().nullable().optional(),
            status: z.enum(EMPLOYEE_STATUSES),
            hireDate: z.string().optional(),
            departmentId: z.number().int().positive().nullable().optional()
        })
        .strict()
);

// PUT /v1/employees/:id applied changes — changedFields are column names.
const EmployeeUpdated = eventEnvelope(
    'strafor.hr.employee_updated',
    1,
    z
        .object({
            ...employeeRef,
            changedFields: z.array(z.string()).min(1),
            status: z.enum(EMPLOYEE_STATUSES).optional()
        })
        .strict()
);

// Employee left: DELETE /v1/employees/:id or an offboarding case completing.
const EmployeeTerminated = eventEnvelope(
    'strafor.hr.employee_terminated',
    1,
    z
        .object({
            ...employeeRef,
            status: z.enum(['terminated', 'resigned']),
            terminationDate: z.string().optional(),
            // What drove the transition, e.g. 'offboarding' | 'manual'.
            reason: z.string().optional()
        })
        .strict()
);

module.exports = { EmployeeCreated, EmployeeUpdated, EmployeeTerminated };
