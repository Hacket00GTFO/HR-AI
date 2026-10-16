import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import type { EventPublisher } from '../events.js';
import { requireHR, serviceOrUserAuth } from '../auth.js';

export interface DepartmentsDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const idParam = z.coerce.number().int().positive();
function parseId(raw: string | undefined): number {
    const parsed = idParam.safeParse(raw);
    if (!parsed.success) throw httpError(400, 'Invalid department id');
    return parsed.data;
}

const departmentSchema = z
    .object({
        name: z.string().min(1).max(200),
        code: z.string().max(50).optional(),
        description: z.string().max(2000).optional(),
        parentDepartmentId: z.number().int().positive().nullable().optional(),
        headEmployeeId: z.number().int().positive().nullable().optional(),
        location: z.string().max(200).optional(),
        costCenter: z.string().max(50).optional(),
        status: z.enum(['active', 'inactive']).default('active')
    })
    .strict();

const updateDepartmentSchema = departmentSchema.partial();

const DEPARTMENT_COLUMNS: Record<string, string> = {
    name: 'name',
    code: 'code',
    description: 'description',
    parentDepartmentId: 'parent_department_id',
    headEmployeeId: 'head_employee_id',
    location: 'location',
    costCenter: 'cost_center',
    status: 'status'
};

function bodyToColumns(body: Record<string, unknown>): { columns: string[]; values: unknown[] } {
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(DEPARTMENT_COLUMNS)) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            columns.push(column);
            values.push(body[key]);
        }
    }
    return { columns, values };
}

const DEPARTMENT_SELECT = `
    SELECT d.*,
           h.first_name AS head_first_name,
           h.last_name  AS head_last_name,
           (SELECT count(*) FROM employees e
             WHERE e.department_id = d.id AND e.deleted_at IS NULL)::int AS employee_count
    FROM departments d
    LEFT JOIN employees h ON h.id = d.head_employee_id AND h.deleted_at IS NULL
`;

export function rowToDepartment(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        name: row.name,
        code: row.code ?? null,
        description: row.description ?? null,
        parentDepartmentId: row.parent_department_id != null ? Number(row.parent_department_id) : null,
        headEmployeeId: row.head_employee_id != null ? Number(row.head_employee_id) : null,
        head:
            row.head_employee_id != null
                ? { firstName: row.head_first_name ?? null, lastName: row.head_last_name ?? null }
                : null,
        location: row.location ?? null,
        costCenter: row.cost_center ?? null,
        status: row.status,
        employeeCount: row.employee_count != null ? Number(row.employee_count) : 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/** Nest flat department rows into a tree (ordered by name). */
export function buildTree(rows: Record<string, unknown>[]) {
    const nodes = new Map<number, Record<string, unknown>>();
    const roots: Record<string, unknown>[] = [];
    for (const r of rows) {
        nodes.set(Number(r.id), { ...rowToDepartment(r), children: [] as unknown[] });
    }
    for (const node of nodes.values()) {
        const parentId = node.parentDepartmentId as number | null;
        const parent = parentId != null ? nodes.get(parentId) : undefined;
        if (parent) (parent.children as unknown[]).push(node);
        else roots.push(node);
    }
    return roots;
}

async function assertLiveDepartment(pool: Pool, id: number, field: string): Promise<void> {
    const { rows } = await pool.query(`SELECT 1 FROM departments WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!rows[0]) throw httpError(400, `${field} references a missing department`);
}

async function assertLiveEmployee(pool: Pool, id: number, field: string): Promise<void> {
    const { rows } = await pool.query(`SELECT 1 FROM employees WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!rows[0]) throw httpError(400, `${field} references a missing employee`);
}

export function departmentsRouter(deps: DepartmentsDeps): Router {
    const { pool, config } = deps;
    const router = Router();

    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR);

    // GET /v1/departments — flat list with parent ids; ?format=tree nests.
    router.get('/', async (req, res, next) => {
        try {
            const { rows } = await pool.query(`${DEPARTMENT_SELECT} WHERE d.deleted_at IS NULL ORDER BY d.name`);
            if (req.query.format === 'tree' || req.query.tree === 'true') {
                return res.json(buildTree(rows));
            }
            res.json(rows.map(rowToDepartment));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/departments
    router.post('/', async (req, res, next) => {
        try {
            const parsed = departmentSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid department payload', parsed.error.issues);
            const data = parsed.data;
            if (data.parentDepartmentId != null) {
                await assertLiveDepartment(pool, data.parentDepartmentId, 'parentDepartmentId');
            }
            if (data.headEmployeeId != null) {
                await assertLiveEmployee(pool, data.headEmployeeId, 'headEmployeeId');
            }
            const { columns, values } = bodyToColumns(data);
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
            let row;
            try {
                ({
                    rows: [row]
                } = await pool.query(
                    `INSERT INTO departments (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
                    values
                ));
            } catch (err) {
                if ((err as { code?: string }).code === '23505') {
                    throw httpError(409, 'A department with this name already exists');
                }
                throw err;
            }
            res.status(201).json(rowToDepartment(row));
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/departments/:id — whitelisted columns; self/cyclic parenting rejected.
    router.put('/:id(\\d+)', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const parsed = updateDepartmentSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid department payload', parsed.error.issues);
            const data = parsed.data;
            if (data.parentDepartmentId !== undefined && data.parentDepartmentId !== null) {
                if (data.parentDepartmentId === id) {
                    throw httpError(400, 'A department cannot be its own parent');
                }
                await assertLiveDepartment(pool, data.parentDepartmentId, 'parentDepartmentId');
                // Cycle check: new parent must not sit inside this department's subtree.
                const { rows: cycle } = await pool.query(
                    `WITH RECURSIVE sub AS (
                         SELECT id FROM departments WHERE id = $1
                         UNION ALL
                         SELECT d.id FROM departments d
                         JOIN sub s ON d.parent_department_id = s.id
                         WHERE d.deleted_at IS NULL
                     )
                     SELECT 1 FROM sub WHERE id = $2`,
                    [id, data.parentDepartmentId]
                );
                if (cycle[0]) throw httpError(409, 'Parent would create a cycle in the org tree');
            }
            if (data.headEmployeeId != null) {
                await assertLiveEmployee(pool, data.headEmployeeId, 'headEmployeeId');
            }
            const { columns, values } = bodyToColumns(data);
            if (columns.length === 0) throw httpError(400, 'No fields to update');
            const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
            let row;
            try {
                ({
                    rows: [row]
                } = await pool.query(
                    `UPDATE departments SET ${sets}, updated_at = now()
                     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
                    [id, ...values]
                ));
            } catch (err) {
                if ((err as { code?: string }).code === '23505') {
                    throw httpError(409, 'A department with this name already exists');
                }
                throw err;
            }
            if (!row) throw httpError(404, 'Department not found');
            res.json(rowToDepartment(row));
        } catch (err) {
            next(err);
        }
    });

    // DELETE /v1/departments/:id — soft delete; blocked while live children
    // or assigned employees reference it.
    router.delete('/:id(\\d+)', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const { rows: children } = await pool.query(
                `SELECT 1 FROM departments WHERE parent_department_id = $1 AND deleted_at IS NULL LIMIT 1`,
                [id]
            );
            if (children[0]) throw httpError(409, 'Department has child departments — reassign them first');
            const { rows: members } = await pool.query(
                `SELECT 1 FROM employees WHERE department_id = $1 AND deleted_at IS NULL LIMIT 1`,
                [id]
            );
            if (members[0]) throw httpError(409, 'Department has assigned employees — reassign them first');
            const { rowCount } = await pool.query(
                `UPDATE departments SET deleted_at = now(), updated_at = now()
                 WHERE id = $1 AND deleted_at IS NULL`,
                [id]
            );
            if (!rowCount) throw httpError(404, 'Department not found');
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    });

    return router;
}
