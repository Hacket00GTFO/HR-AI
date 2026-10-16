import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { httpError, type ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../config.js';
import { enqueueEvent, flushOutbox, type EventPublisher } from '../events.js';
import { actorFor, requireHR, serviceOrUserAuth } from '../auth.js';
import { withTransaction, type Queryable } from '../db.js';
import { maskSecret, type CalendarProvider } from '../provider.js';
import { calendarEventsCancelled, calendarEventsCreated } from '../app.js';

export interface CalendarDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
    provider: CalendarProvider;
}

const freeBusySchema = z
    .object({
        emails: z.array(z.email()).min(1).max(100),
        start: z.iso.datetime(),
        end: z.iso.datetime()
    })
    .strict()
    .refine((v) => new Date(v.end).getTime() > new Date(v.start).getTime(), {
        message: 'end must be after start'
    });

const createEventSchema = z
    .object({
        organizerEmail: z.email(),
        attendees: z.array(z.email()).max(50).default([]),
        subject: z.string().min(1).max(300),
        start: z.iso.datetime(),
        end: z.iso.datetime(),
        /** true → Teams online meeting; non-empty string → room/location. */
        locationOrTeams: z.union([z.boolean(), z.string().max(255)]).default(false),
        body: z.string().max(20000).optional(),
        /** Caller-supplied idempotency key, e.g. 'interview:42'. */
        externalRef: z.string().min(1).max(120).optional(),
        /** Convenience: recruitment-core passes its interview id. */
        interviewId: z.union([z.string().min(1).max(100), z.number().int().positive()]).optional()
    })
    .strict()
    .refine((v) => new Date(v.end).getTime() > new Date(v.start).getTime(), {
        message: 'end must be after start'
    });

interface EventRow {
    id: number | string;
    provider: string;
    provider_event_id: string;
    organizer_email: string;
    attendee_count: number;
    external_ref: string | null;
    start_at: string | Date;
    end_at: string | Date;
    online: boolean;
    join_url: string | null;
    status: string;
}

function toApiEvent(row: EventRow) {
    return {
        id: Number(row.id),
        provider: row.provider,
        providerEventId: row.provider_event_id,
        externalRef: row.external_ref,
        organizer: row.organizer_email,
        attendeeCount: Number(row.attendee_count),
        start: row.start_at instanceof Date ? row.start_at.toISOString() : row.start_at,
        end: row.end_at instanceof Date ? row.end_at.toISOString() : row.end_at,
        online: Boolean(row.online),
        joinUrl: row.join_url,
        status: row.status
    };
}

/** externalRef wins; interviewId is normalised to 'interview:<id>'. */
function resolveExternalRef(v: {
    externalRef?: string | undefined;
    interviewId?: string | number | undefined;
}): string | undefined {
    if (v.externalRef) return v.externalRef;
    if (v.interviewId !== undefined) return `interview:${v.interviewId}`;
    return undefined;
}

async function audit(db: Queryable, actor: string, action: string, externalRef: string | null): Promise<void> {
    await db.query(`INSERT INTO integration_audit (actor, action, external_ref) VALUES ($1, $2, $3)`, [
        actor,
        action,
        externalRef
    ]);
}

/**
 * Calendar business routes — interview scheduling for recruitment-core and
 * (later) the employee portal.
 *
 * Auth: X-Service-Token for internal callers, or gateway user headers with
 * role 'hr' (requireHR). Platform admins are always 403.
 *
 * Privacy: the event subject is persisted only as a SHA-256 hash
 * (subjects routinely embed candidate names); request bodies never reach
 * the DB or the audit trail.
 */
export function calendarRouter(deps: CalendarDeps): Router {
    const { pool, config, publisher, log, provider } = deps;
    const router = Router();

    router.use(serviceOrUserAuth(config.SERVICE_AUTH_TOKEN));
    router.use(requireHR);

    // GET /v1/calendar/provider — active mode + masked config (never leaks
    // secrets; the client secret is reported only as configured/unset).
    router.get('/provider', (_req, res) => {
        res.json({
            provider: provider.mode,
            m365: {
                tenantId: maskSecret(config.M365_TENANT_ID),
                clientId: maskSecret(config.M365_CLIENT_ID),
                clientSecret: config.M365_CLIENT_SECRET ? '********' : null
            }
        });
    });

    // POST /v1/calendar/free-busy — per-email busy intervals in [start, end).
    router.post('/free-busy', async (req, res, next) => {
        try {
            const parsed = freeBusySchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid free-busy request', parsed.error.issues);
            const { emails, start, end } = parsed.data;
            const results = await provider.getFreeBusy(emails, new Date(start), new Date(end));
            await audit(pool, actorFor(req), 'free_busy', null);
            res.json({ provider: provider.mode, results });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/calendar/events — create an event (+ Teams link when
    // locationOrTeams === true). Idempotent on externalRef: a repeat call
    // with the same ref returns the already-scheduled event.
    router.post('/events', async (req, res, next) => {
        try {
            const parsed = createEventSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid event request', parsed.error.issues);
            const input = parsed.data;
            const externalRef = resolveExternalRef(input);

            if (externalRef) {
                const { rows } = await pool.query(
                    `SELECT id, provider, provider_event_id, organizer_email, attendee_count,
                            external_ref, start_at, end_at, online, join_url, status
                     FROM calendar_events
                     WHERE external_ref = $1 AND status = 'scheduled'
                     ORDER BY id LIMIT 1`,
                    [externalRef]
                );
                if (rows[0]) {
                    await audit(pool, actorFor(req), 'event_lookup', externalRef);
                    return res.json({ event: toApiEvent(rows[0] as EventRow), idempotent: true });
                }
            }

            const created = await provider.createEvent({
                organizerEmail: input.organizerEmail,
                attendees: input.attendees,
                subject: input.subject,
                start: input.start,
                end: input.end,
                locationOrTeams: input.locationOrTeams,
                ...(input.body !== undefined ? { body: input.body } : {})
            });

            const subjectHash = createHash('sha256').update(input.subject).digest('hex');
            const actor = actorFor(req);

            const eventId = await withTransaction(pool, async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO calendar_events
                        (provider, provider_event_id, subject_hash, organizer_email, attendee_count,
                         external_ref, start_at, end_at, online, join_url, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'scheduled')
                     RETURNING id`,
                    [
                        provider.mode,
                        created.providerEventId,
                        subjectHash,
                        input.organizerEmail,
                        input.attendees.length,
                        externalRef ?? null,
                        input.start,
                        input.end,
                        input.locationOrTeams === true,
                        created.joinUrl
                    ]
                );
                const id = Number(rows[0]!.id);
                await audit(client, actor, 'event_create', externalRef ?? null);
                await enqueueEvent(
                    client,
                    'strafor.integrations.calendar_event_created',
                    {
                        eventId: id,
                        provider: provider.mode,
                        providerEventId: created.providerEventId,
                        externalRef: externalRef ?? null,
                        organizer: input.organizerEmail,
                        attendeeCount: input.attendees.length,
                        start: input.start,
                        end: input.end
                    },
                    req.correlationId
                );
                return id;
            });
            await flushOutbox(pool, publisher, log).catch(() => {});
            calendarEventsCreated.inc({ provider: provider.mode });

            res.status(201).json({
                event: {
                    id: eventId,
                    provider: provider.mode,
                    providerEventId: created.providerEventId,
                    externalRef: externalRef ?? null,
                    organizer: input.organizerEmail,
                    attendeeCount: input.attendees.length,
                    start: input.start,
                    end: input.end,
                    online: input.locationOrTeams === true,
                    joinUrl: created.joinUrl,
                    status: 'scheduled'
                }
            });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/calendar/events?interviewId=|externalRef= — lookup by the
    // caller-supplied external ref.
    router.get('/events', async (req, res, next) => {
        try {
            const externalRef =
                typeof req.query.externalRef === 'string' && req.query.externalRef
                    ? req.query.externalRef
                    : req.query.interviewId !== undefined
                      ? `interview:${String(req.query.interviewId)}`
                      : undefined;
            if (!externalRef) throw httpError(400, 'Provide interviewId or externalRef');
            const { rows } = await pool.query(
                `SELECT id, provider, provider_event_id, organizer_email, attendee_count,
                        external_ref, start_at, end_at, online, join_url, status
                 FROM calendar_events WHERE external_ref = $1 ORDER BY id`,
                [externalRef]
            );
            await audit(pool, actorFor(req), 'event_lookup', externalRef);
            res.json({ events: rows.map((r) => toApiEvent(r as EventRow)) });
        } catch (err) {
            next(err);
        }
    });

    // DELETE /v1/calendar/events/:id — cancel. `:id` accepts either the
    // internal numeric id or the provider event id ('stub-3', Graph id).
    router.delete('/events/:id', async (req, res, next) => {
        try {
            const key = String(req.params.id);
            const { rows } = await pool.query(
                `SELECT id, provider, provider_event_id, organizer_email, attendee_count,
                        external_ref, start_at, end_at, online, join_url, status
                 FROM calendar_events
                 WHERE id::text = $1 OR provider_event_id = $1
                 ORDER BY id LIMIT 1`,
                [key]
            );
            const row = rows[0] as EventRow | undefined;
            if (!row) throw httpError(404, 'Calendar event not found');
            if (row.status === 'cancelled') {
                return res.json({ event: toApiEvent(row), idempotent: true });
            }

            await provider.cancelEvent(row.organizer_email, row.provider_event_id);

            await withTransaction(pool, async (client) => {
                await client.query(
                    `UPDATE calendar_events SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
                    [row.id]
                );
                await audit(client, actorFor(req), 'event_cancel', row.external_ref);
                await enqueueEvent(
                    client,
                    'strafor.integrations.calendar_event_cancelled',
                    {
                        eventId: Number(row.id),
                        provider: row.provider,
                        providerEventId: row.provider_event_id,
                        externalRef: row.external_ref,
                        organizer: row.organizer_email
                    },
                    req.correlationId
                );
            });
            await flushOutbox(pool, publisher, log).catch(() => {});
            calendarEventsCancelled.inc({ provider: row.provider });

            res.json({ event: { ...toApiEvent(row), status: 'cancelled' } });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
