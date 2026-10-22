import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import { enqueueEvent, flushOutbox, type EventPublisher } from '../events.js';
import { requireEmployee, requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction } from '../db.js';

export interface ExpensesDeps {
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

const itemSchema = z
    .object({
        date: z.iso.date(),
        category: z.string().min(1).max(60).default('other'),
        amount: z.number().positive().max(10_000_000),
        description: z.string().max(500).optional(),
        receiptDocId: z.uuid().nullable().optional()
    })
    .strict();

const createSchema = z
    .object({
        title: z.string().min(1).max(300),
        currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .default('MXN'),
        items: z.array(itemSchema).max(200).default([])
    })
    .strict();

const updateSchema = z
    .object({
        title: z.string().min(1).max(300).optional(),
        currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .optional(),
        // When present, REPLACES the full item list (draft reports only).
        items: z.array(itemSchema).max(200).optional()
    })
    .strict();

const decideSchema = z
    .object({
        decision: z.enum(['approved', 'rejected']),
        comment: z.string().max(2000).optional()
    })
    .strict();

type ExpenseItem = z.infer<typeof itemSchema>;

/** Report total is ALWAYS computed server-side from the item list — the
 *  client can never set or influence it. */
export function computeTotal(items: ExpenseItem[]): number {
    const total = items.reduce((sum, it) => sum + it.amount, 0);
    // Avoid float drift: round to cents.
    return Math.round(total * 100) / 100;
}

function rowToReport(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        employeeId: Number(row.employee_id),
        title: row.title,
        status: row.status,
        currency: row.currency,
        total: Number(row.total),
        submittedAt: row.submitted_at ?? null,
        decidedAt: row.decided_at ?? null,
        paidAt: row.paid_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function rowToItem(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        reportId: Number(row.report_id),
        date:
            row.item_date instanceof Date
                ? row.item_date.toISOString().slice(0, 10)
                : String(row.item_date).slice(0, 10),
        category: row.category,
        amount: Number(row.amount),
        description: row.description ?? null,
        receiptDocId: row.receipt_doc_id ?? null,
        createdAt: row.created_at
    };
}

function rowToApproval(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        reportId: Number(row.report_id),
        approverUserId: row.approver_user_id != null ? Number(row.approver_user_id) : null,
        decision: row.decision,
        comment: row.comment ?? null,
        decidedAt: row.decided_at
    };
}

async function insertItems(client: PoolClient, reportId: number, items: ExpenseItem[]): Promise<void> {
    for (const it of items) {
        await client.query(
            `INSERT INTO expense_items (report_id, item_date, category, amount, description, receipt_doc_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [reportId, it.date, it.category, it.amount, it.description ?? null, it.receiptDocId ?? null]
        );
    }
}

async function reportDetail(pool: Pool, id: number, employeeId?: number) {
    const params: unknown[] = [id];
    let scope = 'r.id = $1';
    if (employeeId !== undefined) {
        params.push(employeeId);
        scope += ' AND r.employee_id = $2';
    }
    const { rows } = await pool.query(`SELECT r.* FROM expense_reports r WHERE ${scope}`, params);
    if (!rows[0]) throw httpError(404, 'Expense report not found');
    const { rows: items } = await pool.query(
        `SELECT * FROM expense_items WHERE report_id = $1 ORDER BY item_date, id`,
        [id]
    );
    const { rows: approvals } = await pool.query(
        `SELECT * FROM expense_approvals WHERE report_id = $1 ORDER BY decided_at, id`,
        [id]
    );
    return {
        ...rowToReport(rows[0]),
        items: items.map(rowToItem),
        approvals: approvals.map(rowToApproval)
    };
}

export function expensesRouter(deps: ExpensesDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();
    const employee = requireEmployee(pool);
    const hr = [serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR];

    // ------------------------------------------------------------------
    // Employee self-service — scoped to req.employeeId.
    // ------------------------------------------------------------------

    // POST /v1/expenses/my — create a draft report with optional items.
    router.post('/my', employee, async (req, res, next) => {
        try {
            const parsed = createSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid expense report payload', parsed.error.issues);
            const data = parsed.data;
            const total = computeTotal(data.items);

            const report = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO expense_reports (employee_id, title, currency, total)
                     VALUES ($1, $2, $3, $4) RETURNING *`,
                    [req.employeeId!, data.title, data.currency, total]
                );
                await insertItems(client, Number(rows[0].id), data.items);
                return rows[0];
            });

            log.info({ reportId: report.id, employeeId: req.employeeId }, 'expense report drafted');
            res.status(201).json(await reportDetail(pool, Number(report.id), req.employeeId!));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/expenses/my — the caller's own reports.
    router.get('/my', employee, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT r.* FROM expense_reports r WHERE r.employee_id = $1 ORDER BY r.created_at DESC`,
                [req.employeeId!]
            );
            res.json(rows.map(rowToReport));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/expenses/my/:id — own report detail (items + approvals).
    router.get('/my/:id(\\d+)', employee, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'report id');
            res.json(await reportDetail(pool, id, req.employeeId!));
        } catch (err) {
            next(err);
        }
    });

    // PUT /v1/expenses/my/:id — edit a draft (title/currency and/or replace
    // the item list). Only drafts are editable → 409 otherwise. The total is
    // recomputed server-side from the stored items.
    router.put('/my/:id(\\d+)', employee, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'report id');
            const parsed = updateSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid expense report payload', parsed.error.issues);
            const data = parsed.data;
            if (Object.keys(data).length === 0) throw httpError(400, 'No fields to update');

            await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `SELECT * FROM expense_reports WHERE id = $1 AND employee_id = $2 FOR UPDATE`,
                    [id, req.employeeId!]
                );
                const report = rows[0];
                if (!report) throw httpError(404, 'Expense report not found');
                if (report.status !== 'draft') {
                    throw httpError(409, `Report is ${report.status} — only drafts can be edited`);
                }
                if (data.items !== undefined) {
                    await client.query(`DELETE FROM expense_items WHERE report_id = $1`, [id]);
                    await insertItems(client, id, data.items);
                }
                await client.query(
                    `UPDATE expense_reports
                     SET title    = COALESCE($2, title),
                         currency = COALESCE($3, currency),
                         total    = (SELECT COALESCE(sum(amount), 0) FROM expense_items WHERE report_id = $1),
                         updated_at = now()
                     WHERE id = $1`,
                    [id, data.title ?? null, data.currency ?? null]
                );
            });

            res.json(await reportDetail(pool, id, req.employeeId!));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/expenses/my/:id/submit — draft → submitted. Requires at
    // least one item. Publishes strafor.services.expense_submitted.
    router.post('/my/:id(\\d+)/submit', employee, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'report id');
            const row = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `SELECT * FROM expense_reports WHERE id = $1 AND employee_id = $2 FOR UPDATE`,
                    [id, req.employeeId!]
                );
                const report = rows[0];
                if (!report) throw httpError(404, 'Expense report not found');
                if (report.status !== 'draft') {
                    throw httpError(409, `Report is ${report.status} — only drafts can be submitted`);
                }
                const { rows: counts } = await client.query(
                    `SELECT count(*)::int AS n FROM expense_items WHERE report_id = $1`,
                    [id]
                );
                if (Number(counts[0]?.n ?? 0) === 0) {
                    throw httpError(409, 'Cannot submit a report with no expense items');
                }
                const { rows: updated } = await client.query(
                    `UPDATE expense_reports SET status = 'submitted', submitted_at = now(), updated_at = now()
                     WHERE id = $1 RETURNING *`,
                    [id]
                );
                await enqueueEvent(
                    client,
                    'strafor.services.expense_submitted',
                    {
                        reportId: id,
                        employeeId: req.employeeId!,
                        total: Number(updated[0].total),
                        currency: updated[0].currency
                    },
                    req.correlationId
                );
                return updated[0];
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            res.json(rowToReport(row));
        } catch (err) {
            next(err);
        }
    });

    // ------------------------------------------------------------------
    // HR management — strictly role 'hr'; service token for internal callers.
    // ------------------------------------------------------------------

    // GET /v1/expenses — allowlisted filters (status, employeeId).
    router.get('/', ...hr, async (req, res, next) => {
        try {
            const where: string[] = ['TRUE'];
            const params: unknown[] = [];
            for (const [key, value] of Object.entries(req.query)) {
                if (value == null || value === '' || Array.isArray(value)) continue;
                const column = { status: 'status', employeeId: 'employee_id' }[key];
                if (!column) continue;
                params.push(value);
                where.push(`r.${column} = $${params.length}`);
            }
            const { rows } = await pool.query(
                `SELECT r.* FROM expense_reports r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC`,
                params
            );
            res.json(rows.map(rowToReport));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/expenses/:id — any report with items + approvals.
    router.get('/:id(\\d+)', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'report id');
            res.json(await reportDetail(pool, id));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/expenses/:id/decide — submitted → approved|rejected. Any
    // other state is a 409. Writes expense_approvals and publishes
    // strafor.services.expense_decided.
    router.post('/:id(\\d+)/decide', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'report id');
            const parsed = decideSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid decision payload', parsed.error.issues);
            const { decision, comment } = parsed.data;

            const row = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM expense_reports WHERE id = $1 FOR UPDATE`, [id]);
                const report = rows[0];
                if (!report) throw httpError(404, 'Expense report not found');
                if (report.status !== 'submitted') {
                    throw httpError(409, `Report is ${report.status} — only submitted reports can be decided`);
                }
                await client.query(
                    `INSERT INTO expense_approvals (report_id, approver_user_id, decision, comment)
                     VALUES ($1, $2, $3, $4)`,
                    [id, req.user?.userId ?? null, decision, comment ?? null]
                );
                const { rows: updated } = await client.query(
                    `UPDATE expense_reports SET status = $2, decided_at = now(), updated_at = now()
                     WHERE id = $1 RETURNING *`,
                    [id, decision]
                );
                await enqueueEvent(
                    client,
                    'strafor.services.expense_decided',
                    {
                        reportId: id,
                        employeeId: Number(report.employee_id),
                        decision,
                        approverUserId: req.user?.userId ?? null,
                        total: Number(report.total),
                        currency: report.currency
                    },
                    req.correlationId
                );
                return updated[0];
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            log.info({ reportId: id, decision }, 'expense report decided');
            res.json(rowToReport(row));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/expenses/:id/pay — approved → paid. Anything else is a 409.
    router.post('/:id(\\d+)/pay', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'report id');
            const { rows } = await pool.query(
                `UPDATE expense_reports SET status = 'paid', paid_at = now(), updated_at = now()
                 WHERE id = $1 AND status = 'approved'
                 RETURNING *`,
                [id]
            );
            if (!rows[0]) {
                const { rows: existing } = await pool.query(`SELECT status FROM expense_reports WHERE id = $1`, [id]);
                if (!existing[0]) throw httpError(404, 'Expense report not found');
                throw httpError(409, `Report is ${existing[0].status} — only approved reports can be paid`);
            }
            res.json(rowToReport(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    return router;
}
