import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import { enqueueEvent, flushOutbox, type EventPublisher } from '../events.js';
import { requireEmployee, requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction } from '../db.js';

export interface AssetsDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}

const idParam = z.coerce.number().int().positive();
function parseId(raw: string | undefined, what = 'id'): number {
    const parsed = idParam.safeParse(raw);
    if (!parsed.success) throw httpError(400, `Invalid ${what}`);
    return parsed.data;
}

const createSchema = z
    .object({
        tag: z.string().min(1).max(80),
        type: z.string().min(1).max(60).default('other'),
        serial: z.string().max(120).nullable().optional(),
        description: z.string().max(300).nullable().optional(),
        status: z.enum(['available', 'maintenance', 'retired']).default('available')
    })
    .strict();

const updateSchema = z
    .object({
        tag: z.string().min(1).max(80).optional(),
        type: z.string().min(1).max(60).optional(),
        serial: z.string().max(120).nullable().optional(),
        description: z.string().max(300).nullable().optional(),
        status: z.enum(['available', 'maintenance', 'retired']).optional()
    })
    .strict();

const checkoutSchema = z
    .object({
        employeeId: z.number().int().positive(),
        conditionOut: z.string().max(2000).optional()
    })
    .strict();

const checkinSchema = z
    .object({
        conditionIn: z.string().max(2000).optional(),
        // Where the asset lands after return; defaults to 'available'.
        status: z.enum(['available', 'maintenance']).default('available')
    })
    .strict();

const FILTER_COLUMNS: Record<string, string> = {
    status: 'status',
    type: 'type',
    tag: 'tag'
};

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

function rowToAsset(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        tag: row.tag,
        type: row.type,
        serial: row.serial ?? null,
        description: row.description ?? null,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function rowToAssignment(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        assetId: Number(row.asset_id),
        employeeId: Number(row.employee_id),
        assignedAt: row.assigned_at,
        returnedAt: row.returned_at ?? null,
        conditionOut: row.condition_out ?? null,
        conditionIn: row.condition_in ?? null,
        assignedBy: row.assigned_by != null ? Number(row.assigned_by) : null,
        returnedBy: row.returned_by != null ? Number(row.returned_by) : null,
        ...(row.asset_tag !== undefined
            ? {
                  asset: {
                      tag: row.asset_tag,
                      type: row.asset_type ?? null,
                      serial: row.asset_serial ?? null
                  }
              }
            : {})
    };
}

export function assetsRouter(deps: AssetsDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();
    const employee = requireEmployee(pool);
    const hr = [serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR];

    // ------------------------------------------------------------------
    // Employee self-service
    // ------------------------------------------------------------------

    // GET /v1/assets/my — the caller's assignments (open and returned),
    // joined with the asset for display.
    router.get('/my', employee, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT a.*, ast.tag AS asset_tag, ast.type AS asset_type, ast.serial AS asset_serial
                 FROM asset_assignments a
                 JOIN assets ast ON ast.id = a.asset_id
                 WHERE a.employee_id = $1
                 ORDER BY a.assigned_at DESC`,
                [req.employeeId!]
            );
            res.json(rows.map(rowToAssignment));
        } catch (err) {
            next(err);
        }
    });

    // ------------------------------------------------------------------
    // HR management — strictly role 'hr'; service token for internal callers.
    // ------------------------------------------------------------------

    // GET /v1/assets — allowlisted filters (status, type, tag).
    router.get('/', ...hr, async (req, res, next) => {
        try {
            const where: string[] = ['TRUE'];
            const params: unknown[] = [];
            for (const [key, value] of Object.entries(req.query)) {
                if (value == null || value === '' || Array.isArray(value)) continue;
                const column = FILTER_COLUMNS[key];
                if (!column) continue;
                params.push(value);
                where.push(`a.${column} = $${params.length}`);
            }
            const { rows } = await pool.query(
                `SELECT a.* FROM assets a WHERE ${where.join(' AND ')} ORDER BY a.tag`,
                params
            );
            res.json(rows.map(rowToAsset));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/assets — register an asset (unique inventory tag).
    router.post('/', ...hr, async (req, res, next) => {
        try {
            const parsed = createSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid asset payload', parsed.error.issues);
            const d = parsed.data;
            let row;
            try {
                ({
                    rows: [row]
                } = await pool.query(
                    `INSERT INTO assets (tag, type, serial, description, status)
                     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                    [d.tag, d.type, d.serial ?? null, d.description ?? null, d.status]
                ));
            } catch (err) {
                if (isUniqueViolation(err)) throw httpError(409, 'An asset with this tag already exists');
                throw err;
            }
            log.info({ assetId: row.id, tag: d.tag }, 'asset registered');
            res.status(201).json(rowToAsset(row));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/assets/:id
    router.get('/:id(\\d+)', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'asset id');
            const { rows } = await pool.query(`SELECT a.* FROM assets a WHERE a.id = $1`, [id]);
            if (!rows[0]) throw httpError(404, 'Asset not found');
            res.json(rowToAsset(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/assets/:id/assignments — full checkout ledger for an asset.
    router.get('/:id(\\d+)/assignments', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'asset id');
            const { rows: asset } = await pool.query(`SELECT id FROM assets WHERE id = $1`, [id]);
            if (!asset[0]) throw httpError(404, 'Asset not found');
            const { rows } = await pool.query(
                `SELECT a.*, ast.tag AS asset_tag, ast.type AS asset_type, ast.serial AS asset_serial
                 FROM asset_assignments a
                 JOIN assets ast ON ast.id = a.asset_id
                 WHERE a.asset_id = $1
                 ORDER BY a.assigned_at DESC`,
                [id]
            );
            res.json(rows.map(rowToAssignment));
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/assets/:id — whitelisted field/status update. An assigned
    // asset cannot be retired/marked available directly — check it in first.
    router.put('/:id(\\d+)', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'asset id');
            const parsed = updateSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid asset payload', parsed.error.issues);
            const data = parsed.data;
            if (Object.keys(data).length === 0) throw httpError(400, 'No fields to update');
            if (data.status !== undefined) {
                const { rows: open } = await pool.query(
                    `SELECT 1 FROM asset_assignments WHERE asset_id = $1 AND returned_at IS NULL LIMIT 1`,
                    [id]
                );
                if (open[0]) {
                    throw httpError(409, 'Asset has an open assignment — check it in before changing status');
                }
            }
            const sets: string[] = [];
            const params: unknown[] = [id];
            for (const [key, column] of Object.entries({
                tag: 'tag',
                type: 'type',
                serial: 'serial',
                description: 'description',
                status: 'status'
            })) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    params.push((data as Record<string, unknown>)[key]);
                    sets.push(`${column} = $${params.length}`);
                }
            }
            let row;
            try {
                ({
                    rows: [row]
                } = await pool.query(
                    `UPDATE assets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
                    params
                ));
            } catch (err) {
                if (isUniqueViolation(err)) throw httpError(409, 'An asset with this tag already exists');
                throw err;
            }
            if (!row) throw httpError(404, 'Asset not found');
            res.json(rowToAsset(row));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/assets/:id/checkout — assign to an employee. Requires status
    // 'available' (409 otherwise). Publishes strafor.services.asset_assigned.
    router.post('/:id(\\d+)/checkout', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'asset id');
            const parsed = checkoutSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid checkout payload', parsed.error.issues);

            const result = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM assets WHERE id = $1 FOR UPDATE`, [id]);
                const asset = rows[0];
                if (!asset) throw httpError(404, 'Asset not found');
                if (asset.status !== 'available') {
                    throw httpError(409, `Asset is ${asset.status} — only available assets can be checked out`);
                }
                const { rows: assignment } = await client.query(
                    `INSERT INTO asset_assignments (asset_id, employee_id, condition_out, assigned_by)
                     VALUES ($1, $2, $3, $4) RETURNING *`,
                    [id, parsed.data.employeeId, parsed.data.conditionOut ?? null, req.user?.userId ?? null]
                );
                await client.query(`UPDATE assets SET status = 'assigned', updated_at = now() WHERE id = $1`, [id]);
                await enqueueEvent(
                    client,
                    'strafor.services.asset_assigned',
                    {
                        assetId: id,
                        assetTag: asset.tag,
                        employeeId: parsed.data.employeeId,
                        assignmentId: Number(assignment[0].id)
                    },
                    req.correlationId
                );
                return { assignment: assignment[0], asset };
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            log.info({ assetId: id, employeeId: parsed.data.employeeId }, 'asset checked out');
            res.status(201).json(rowToAssignment(result.assignment));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/assets/:id/checkin — close the open assignment, record the
    // return condition and the asset's next status. Publishes asset_returned.
    router.post('/:id(\\d+)/checkin', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'asset id');
            const parsed = checkinSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid checkin payload', parsed.error.issues);

            const result = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM assets WHERE id = $1 FOR UPDATE`, [id]);
                const asset = rows[0];
                if (!asset) throw httpError(404, 'Asset not found');
                if (asset.status !== 'assigned') {
                    throw httpError(409, `Asset is ${asset.status} — only assigned assets can be checked in`);
                }
                const { rows: closed } = await client.query(
                    `UPDATE asset_assignments
                     SET returned_at = now(), condition_in = $2, returned_by = $3
                     WHERE asset_id = $1 AND returned_at IS NULL
                     RETURNING *`,
                    [id, parsed.data.conditionIn ?? null, req.user?.userId ?? null]
                );
                if (!closed[0]) throw httpError(409, 'Asset has no open assignment');
                await client.query(`UPDATE assets SET status = $2, updated_at = now() WHERE id = $1`, [
                    id,
                    parsed.data.status
                ]);
                await enqueueEvent(
                    client,
                    'strafor.services.asset_returned',
                    {
                        assetId: id,
                        assetTag: asset.tag,
                        employeeId: Number(closed[0].employee_id),
                        assignmentId: Number(closed[0].id),
                        assetStatus: parsed.data.status
                    },
                    req.correlationId
                );
                return closed[0];
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            res.json(rowToAssignment(result));
        } catch (err) {
            next(err);
        }
    });

    return router;
}
