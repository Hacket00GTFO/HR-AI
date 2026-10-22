import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import { enqueueEvent, flushOutbox, type EventPublisher } from '../events.js';
import { requireEmployee, requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction } from '../db.js';
import { ticketsResolved } from '../app.js';

export interface TicketsDeps {
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

const PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;
type Priority = (typeof PRIORITIES)[number];

/** SLA hours by priority — defaults critical 4h / high 24h / normal 72h /
 *  low 7d, overridable via SLA_*_HOURS env vars (see config.ts). */
export function slaHoursFor(priority: Priority, config: ServiceConfig): number {
    switch (priority) {
        case 'critical':
            return config.SLA_CRITICAL_HOURS;
        case 'high':
            return config.SLA_HIGH_HOURS;
        case 'low':
            return config.SLA_LOW_HOURS;
        case 'normal':
        default:
            return config.SLA_NORMAL_HOURS;
    }
}

/** Ticket SLA due date = creation time + per-priority SLA hours. */
export function slaDueAt(priority: Priority, config: ServiceConfig, from: Date = new Date()): Date {
    return new Date(from.getTime() + slaHoursFor(priority, config) * 3_600_000);
}

/**
 * Allowed HR-side status transitions. `assigned` is normally reached via
 * POST /:id/assign but is also a legal direct transition from `new`.
 * `resolved → in_progress` is the reopen path; `closed` is terminal.
 */
const TRANSITIONS: Record<string, readonly string[]> = {
    new: ['assigned', 'in_progress', 'closed'],
    assigned: ['in_progress', 'waiting_employee', 'resolved', 'closed'],
    in_progress: ['waiting_employee', 'resolved', 'closed'],
    waiting_employee: ['in_progress', 'resolved', 'closed'],
    resolved: ['closed', 'in_progress'],
    closed: []
};

const createSchema = z
    .object({
        category: z.string().min(1).max(60).default('general'),
        subject: z.string().min(1).max(300),
        description: z.string().min(1).max(10000),
        priority: z.enum(PRIORITIES).default('normal')
    })
    .strict();

const createForSchema = createSchema.extend({
    employeeId: z.number().int().positive()
});

const commentSchema = z
    .object({
        body: z.string().min(1).max(5000)
    })
    .strict();

const assignSchema = z
    .object({
        assigneeUserId: z.number().int().positive()
    })
    .strict();

const transitionSchema = z
    .object({
        status: z.enum(['assigned', 'in_progress', 'waiting_employee', 'resolved', 'closed']),
        note: z.string().max(2000).optional()
    })
    .strict();

const FILTER_COLUMNS: Record<string, string> = {
    status: 'status',
    priority: 'priority',
    category: 'category',
    assigneeUserId: 'assignee_user_id',
    employeeId: 'employee_id'
};

function rowToTicket(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        employeeId: Number(row.employee_id),
        category: row.category,
        subject: row.subject,
        description: row.description,
        status: row.status,
        priority: row.priority,
        assigneeUserId: row.assignee_user_id != null ? Number(row.assignee_user_id) : null,
        slaDueAt: row.sla_due_at ?? null,
        resolvedAt: row.resolved_at ?? null,
        closedAt: row.closed_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function rowToComment(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        ticketId: Number(row.ticket_id),
        authorUserId: Number(row.author_user_id),
        authorKind: row.author_kind,
        body: row.body,
        createdAt: row.created_at
    };
}

function rowToHistory(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        ticketId: Number(row.ticket_id),
        fromStatus: row.from_status ?? null,
        toStatus: row.to_status,
        changedBy: row.changed_by != null ? Number(row.changed_by) : null,
        note: row.note ?? null,
        createdAt: row.created_at
    };
}

async function ticketDetail(pool: Pool, id: number, employeeId?: number) {
    const params: unknown[] = [id];
    let scope = 't.id = $1';
    if (employeeId !== undefined) {
        params.push(employeeId);
        scope += ' AND t.employee_id = $2';
    }
    const { rows } = await pool.query(`SELECT t.* FROM tickets t WHERE ${scope}`, params);
    if (!rows[0]) throw httpError(404, 'Ticket not found');
    const { rows: comments } = await pool.query(`SELECT * FROM ticket_comments WHERE ticket_id = $1 ORDER BY id`, [id]);
    const { rows: history } = await pool.query(`SELECT * FROM ticket_status_history WHERE ticket_id = $1 ORDER BY id`, [
        id
    ]);
    return {
        ...rowToTicket(rows[0]),
        comments: comments.map(rowToComment),
        history: history.map(rowToHistory)
    };
}

export function ticketsRouter(deps: TicketsDeps): Router {
    const { pool, config, publisher, log } = deps;
    const router = Router();
    const employee = requireEmployee(pool);
    const hr = [serviceOrUserAuth(config.SERVICE_AUTH_TOKEN), requireHR];

    // ------------------------------------------------------------------
    // Employee self-service — every query is scoped to req.employeeId.
    // ------------------------------------------------------------------

    // POST /v1/tickets/my — employee opens a ticket; sla_due_at is
    // server-computed from priority. Publishes strafor.services.ticket_created.
    router.post('/my', employee, async (req, res, next) => {
        try {
            const parsed = createSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid ticket payload', parsed.error.issues);
            const data = parsed.data;
            const employeeId = req.employeeId!;
            const due = slaDueAt(data.priority, config);

            const row = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO tickets (employee_id, category, subject, description, priority, sla_due_at, created_by_user_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                    [employeeId, data.category, data.subject, data.description, data.priority, due, req.user!.userId]
                );
                const ticket = rows[0];
                await client.query(
                    `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, note)
                     VALUES ($1, NULL, 'new', $2, 'ticket created')`,
                    [ticket.id, req.user!.userId]
                );
                await enqueueEvent(
                    client,
                    'strafor.services.ticket_created',
                    {
                        ticketId: Number(ticket.id),
                        employeeId,
                        category: data.category,
                        priority: data.priority,
                        status: 'new',
                        slaDueAt: due.toISOString()
                    },
                    req.correlationId
                );
                return ticket;
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            log.info({ ticketId: row.id, employeeId }, 'ticket created');
            res.status(201).json(rowToTicket(row));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/tickets/my — the caller's own tickets, newest first.
    router.get('/my', employee, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT t.* FROM tickets t WHERE t.employee_id = $1 ORDER BY t.created_at DESC`,
                [req.employeeId!]
            );
            res.json(rows.map(rowToTicket));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/tickets/my/:id — own ticket detail (comments + history).
    router.get('/my/:id(\\d+)', employee, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'ticket id');
            res.json(await ticketDetail(pool, id, req.employeeId!));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/tickets/my/:id/comments — comment on own ticket.
    router.post('/my/:id(\\d+)/comments', employee, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'ticket id');
            const parsed = commentSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid comment payload', parsed.error.issues);
            // The employee_id predicate makes the ticket unreachable for
            // anyone but its owner — comments on others' tickets are 404.
            const { rows } = await pool.query(
                `INSERT INTO ticket_comments (ticket_id, author_user_id, author_kind, body)
                 SELECT t.id, $2, 'employee', $3 FROM tickets t
                 WHERE t.id = $1 AND t.employee_id = $4
                 RETURNING *`,
                [id, req.user!.userId, parsed.data.body, req.employeeId!]
            );
            if (!rows[0]) throw httpError(404, 'Ticket not found');
            res.status(201).json(rowToComment(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    // ------------------------------------------------------------------
    // HR management — strictly role 'hr' (admins get 403); trusted service
    // callers may present X-Service-Token instead.
    // ------------------------------------------------------------------

    // POST /v1/tickets — HR opens a ticket on behalf of an employee.
    router.post('/', ...hr, async (req, res, next) => {
        try {
            const parsed = createForSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid ticket payload', parsed.error.issues);
            const data = parsed.data;
            const due = slaDueAt(data.priority, config);

            const row = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO tickets (employee_id, category, subject, description, priority, sla_due_at, created_by_user_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                    [
                        data.employeeId,
                        data.category,
                        data.subject,
                        data.description,
                        data.priority,
                        due,
                        req.user?.userId ?? null
                    ]
                );
                const ticket = rows[0];
                await client.query(
                    `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, note)
                     VALUES ($1, NULL, 'new', $2, 'ticket created')`,
                    [ticket.id, req.user?.userId ?? null]
                );
                await enqueueEvent(
                    client,
                    'strafor.services.ticket_created',
                    {
                        ticketId: Number(ticket.id),
                        employeeId: data.employeeId,
                        category: data.category,
                        priority: data.priority,
                        status: 'new',
                        slaDueAt: due.toISOString()
                    },
                    req.correlationId
                );
                return ticket;
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            res.status(201).json(rowToTicket(row));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/tickets — allowlisted filters (status, priority, category,
    // assigneeUserId, employeeId).
    router.get('/', ...hr, async (req, res, next) => {
        try {
            const where: string[] = ['TRUE'];
            const params: unknown[] = [];
            for (const [key, value] of Object.entries(req.query)) {
                if (value == null || value === '' || Array.isArray(value)) continue;
                const column = FILTER_COLUMNS[key];
                if (!column) continue;
                params.push(value);
                where.push(`t.${column} = $${params.length}`);
            }
            const { rows } = await pool.query(
                `SELECT t.* FROM tickets t WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC`,
                params
            );
            res.json(rows.map(rowToTicket));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/tickets/:id — any ticket with comments + status history.
    router.get('/:id(\\d+)', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'ticket id');
            res.json(await ticketDetail(pool, id));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/tickets/:id/assign — set the assignee; the ticket moves to
    // 'assigned' unless it is already past intake. Publishes ticket_assigned.
    router.post('/:id(\\d+)/assign', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'ticket id');
            const parsed = assignSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid assign payload', parsed.error.issues);
            const assignee = parsed.data.assigneeUserId;

            const row = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM tickets WHERE id = $1 FOR UPDATE`, [id]);
                const ticket = rows[0];
                if (!ticket) throw httpError(404, 'Ticket not found');
                if (['resolved', 'closed'].includes(ticket.status)) {
                    throw httpError(409, `Cannot assign a ${ticket.status} ticket`);
                }
                const newStatus = ticket.status === 'new' ? 'assigned' : ticket.status;
                const { rows: updated } = await client.query(
                    `UPDATE tickets SET assignee_user_id = $2, status = $3, updated_at = now()
                     WHERE id = $1 RETURNING *`,
                    [id, assignee, newStatus]
                );
                if (newStatus !== ticket.status) {
                    await client.query(
                        `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, note)
                         VALUES ($1, $2, $3, $4, 'assigned')`,
                        [id, ticket.status, newStatus, req.user?.userId ?? null]
                    );
                }
                await enqueueEvent(
                    client,
                    'strafor.services.ticket_assigned',
                    {
                        ticketId: id,
                        employeeId: Number(ticket.employee_id),
                        assigneeUserId: assignee,
                        status: newStatus
                    },
                    req.correlationId
                );
                return updated[0];
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);

            res.json(rowToTicket(row));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/tickets/:id/transition — HR status move per TRANSITIONS;
    // invalid transitions get 409. 'resolved' publishes ticket_resolved.
    router.post('/:id(\\d+)/transition', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'ticket id');
            const parsed = transitionSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid transition payload', parsed.error.issues);
            const target = parsed.data.status;

            const row = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(`SELECT * FROM tickets WHERE id = $1 FOR UPDATE`, [id]);
                const ticket = rows[0];
                if (!ticket) throw httpError(404, 'Ticket not found');
                if (!TRANSITIONS[ticket.status]?.includes(target)) {
                    throw httpError(409, `Cannot transition ticket from ${ticket.status} to ${target}`);
                }
                const { rows: updated } = await client.query(
                    `UPDATE tickets
                     SET status = $2,
                         resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END,
                         closed_at   = CASE WHEN $2 = 'closed'   THEN now() ELSE closed_at END,
                         updated_at  = now()
                     WHERE id = $1 RETURNING *`,
                    [id, target]
                );
                await client.query(
                    `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, note)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [id, ticket.status, target, req.user?.userId ?? null, parsed.data.note ?? null]
                );
                if (target === 'resolved') {
                    await enqueueEvent(
                        client,
                        'strafor.services.ticket_resolved',
                        {
                            ticketId: id,
                            employeeId: Number(ticket.employee_id),
                            resolvedBy: req.user?.userId ?? null,
                            status: 'resolved'
                        },
                        req.correlationId
                    );
                }
                return updated[0];
            });
            await flushOutbox(pool, publisher, log).catch(() => 0);
            if (row.status === 'resolved') ticketsResolved.inc({ priority: String(row.priority) });

            res.json(rowToTicket(row));
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/tickets/:id/comments — HR comment on any ticket.
    router.post('/:id(\\d+)/comments', ...hr, async (req, res, next) => {
        try {
            const id = parseId(req.params.id, 'ticket id');
            const parsed = commentSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid comment payload', parsed.error.issues);
            const { rows } = await pool.query(
                `INSERT INTO ticket_comments (ticket_id, author_user_id, author_kind, body)
                 SELECT t.id, $2, 'hr', $3 FROM tickets t WHERE t.id = $1
                 RETURNING *`,
                [id, req.user?.userId ?? 0, parsed.data.body]
            );
            if (!rows[0]) throw httpError(404, 'Ticket not found');
            res.status(201).json(rowToComment(rows[0]));
        } catch (err) {
            next(err);
        }
    });

    return router;
}
