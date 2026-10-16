import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import { EmployeeCreated, EmployeeUpdated, EmployeeTerminated } from '@strafor/contracts/events/hr.js';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { requireHR, serviceOrUserAuth } from '../auth.js';
import {
    buildEmployeeFilters,
    bodyToColumns,
    createEmployeeSchema,
    rowToEmployee,
    updateEmployeeSchema
} from '../employees.js';

export interface EmployeesDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const idParam = z.coerce.number().int().positive();
function parseId(raw: string | undefined): number {
    const parsed = idParam.safeParse(raw);
    if (!parsed.success) throw httpError(400, 'Invalid employee id');
    return parsed.data;
}

/** rfc/curp/nss/salary are emitted only to the hr role. Service callers get
 *  the non-sensitive view — sub-roles/field grants land later. */
function canSeeSensitive(req: Request): boolean {
    return req.user?.role === 'hr';
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

const EMPLOYEE_SELECT = `
    SELECT e.*, up.first_name AS user_first_name, up.last_name AS user_last_name
    FROM employees e
    LEFT JOIN users_projection up ON up.id = e.user_id
`;

export function employeesRouter(deps: EmployeesDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();

    // Every employee endpoint requires HR — admins get 403 (governance:
    // platform admins never see employee records incl. financial fields).
    // Trusted internal callers may present X-Service-Token instead.
    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR);

    // GET /v1/employees — allowlisted filters + ?q= ILIKE search.
    router.get('/', async (req, res, next) => {
        try {
            const { where, params } = buildEmployeeFilters(req.query as Record<string, unknown>);
            const { rows } = await pool.query(
                `${EMPLOYEE_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC`,
                params
            );
            const sensitive = canSeeSensitive(req);
            res.json(rows.map((r) => rowToEmployee(r, sensitive)));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/employees — validated create; publishes employee_created.
    router.post('/', async (req, res, next) => {
        try {
            const parsed = createEmployeeSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid employee payload', parsed.error.issues);
            const { columns, values } = bodyToColumns(parsed.data);
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
            let row;
            try {
                ({
                    rows: [row]
                } = await pool.query(
                    `INSERT INTO employees (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
                    values
                ));
            } catch (err) {
                if (isUniqueViolation(err)) {
                    throw httpError(409, 'Duplicate employee number, email or user link');
                }
                throw err;
            }
            await publisher.publish(
                EmployeeCreated,
                'strafor.hr.employee_created',
                {
                    employeeId: Number(row.id),
                    employeeNumber: row.employee_number,
                    userId: row.user_id ?? null,
                    status: row.status,
                    hireDate:
                        row.hire_date instanceof Date
                            ? row.hire_date.toISOString().slice(0, 10)
                            : String(row.hire_date),
                    departmentId: row.department_id != null ? Number(row.department_id) : null
                },
                req.correlationId
            );
            log.info({ employeeId: row.id }, 'employee created');
            res.status(201).json(rowToEmployee(row, canSeeSensitive(req)));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/employees/:id/documents — links to documents-resumes records.
    router.get('/:id(\\d+)/documents', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const { rows } = await pool.query(
                `SELECT ed.id, ed.document_id, ed.kind, ed.uploaded_by, ed.created_at
                 FROM employee_documents ed
                 JOIN employees e ON e.id = ed.employee_id AND e.deleted_at IS NULL
                 WHERE ed.employee_id = $1
                 ORDER BY ed.created_at DESC`,
                [id]
            );
            res.json(
                rows.map((r) => ({
                    id: Number(r.id),
                    employeeId: id,
                    documentId: r.document_id,
                    kind: r.kind,
                    uploadedBy: r.uploaded_by ?? null,
                    createdAt: r.created_at
                }))
            );
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/employees/:id/documents — link an existing document UUID.
    router.post('/:id(\\d+)/documents', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const body = z
                .object({
                    documentId: z.uuid(),
                    kind: z.string().min(1).max(60).default('other')
                })
                .strict()
                .safeParse(req.body);
            if (!body.success) throw httpError(400, 'Invalid document link', body.error.issues);
            const uploadedBy = req.user?.userId ?? null;
            try {
                const { rows } = await pool.query(
                    `INSERT INTO employee_documents (employee_id, document_id, kind, uploaded_by)
                     SELECT e.id, $2, $3, $4 FROM employees e
                     WHERE e.id = $1 AND e.deleted_at IS NULL
                     RETURNING id, document_id, kind, uploaded_by, created_at`,
                    [id, body.data.documentId, body.data.kind, uploadedBy]
                );
                if (!rows[0]) throw httpError(404, 'Employee not found');
                const r = rows[0];
                res.status(201).json({
                    id: Number(r.id),
                    employeeId: id,
                    documentId: r.document_id,
                    kind: r.kind,
                    uploadedBy: r.uploaded_by ?? null,
                    createdAt: r.created_at
                });
            } catch (err) {
                if (isUniqueViolation(err)) throw httpError(409, 'Document already linked');
                throw err;
            }
        } catch (err) {
            next(err);
        }
    });

    // DELETE /v1/employees/:id/documents/:linkId — unlink (does not delete
    // the document itself; that lives in documents-resumes).
    router.delete('/:id(\\d+)/documents/:linkId(\\d+)', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const linkId = parseId(req.params.linkId);
            const { rowCount } = await pool.query(`DELETE FROM employee_documents WHERE id = $1 AND employee_id = $2`, [
                linkId,
                id
            ]);
            if (!rowCount) throw httpError(404, 'Document link not found');
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/employees/:id
    router.get('/:id(\\d+)', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const { rows } = await pool.query(`${EMPLOYEE_SELECT} WHERE e.id = $1 AND e.deleted_at IS NULL`, [id]);
            if (!rows[0]) throw httpError(404, 'Employee not found');
            res.json(rowToEmployee(rows[0], canSeeSensitive(req)));
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/employees/:id — column-whitelisted update.
    router.put('/:id(\\d+)', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = updateEmployeeSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid employee payload', parsed.error.issues);
            const { columns, values } = bodyToColumns(parsed.data);
            if (columns.length === 0) throw httpError(400, 'No fields to update');
            const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
            let row;
            try {
                ({
                    rows: [row]
                } = await pool.query(
                    `UPDATE employees SET ${sets}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
                    [id, ...values]
                ));
            } catch (err) {
                if (isUniqueViolation(err)) {
                    throw httpError(409, 'Duplicate employee number, email or user link');
                }
                throw err;
            }
            if (!row) throw httpError(404, 'Employee not found');
            await publisher.publish(
                EmployeeUpdated,
                'strafor.hr.employee_updated',
                {
                    employeeId: Number(row.id),
                    employeeNumber: row.employee_number,
                    changedFields: columns,
                    status: row.status
                },
                req.correlationId
            );
            res.json(rowToEmployee(row, canSeeSensitive(req)));
        } catch (err) {
            next(err);
        }
    });

    // DELETE /v1/employees/:id — soft delete; publishes employee_terminated.
    router.delete('/:id(\\d+)', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const { rows } = await pool.query(
                `UPDATE employees SET deleted_at = now(), updated_at = now()
                 WHERE id = $1 AND deleted_at IS NULL
                 RETURNING id, employee_number, status`,
                [id]
            );
            if (!rows[0]) throw httpError(404, 'Employee not found');
            const row = rows[0];
            await publisher.publish(
                EmployeeTerminated,
                'strafor.hr.employee_terminated',
                {
                    employeeId: Number(row.id),
                    employeeNumber: row.employee_number,
                    status: ['terminated', 'resigned'].includes(row.status) ? row.status : 'terminated',
                    reason: 'manual'
                },
                req.correlationId
            );
            log.info({ employeeId: row.id }, 'employee soft-deleted');
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    });

    return router;
}
