import { Router } from 'express';
import { z } from 'zod';
import { httpError } from '@strafor/node-common';
import { AttendanceRecorded } from '../eventSchemas.js';
import { requireHR, requireReviewer, requireUser, type GatewayUser } from '../auth.js';
import { withTransaction } from '../db.js';
import { attendanceRecorded } from '../app.js';
import type { TimeDeps } from '../deps.js';

const EVENT_KINDS = ['check_in', 'check_out', 'break_start', 'break_end'] as const;

const checkSchema = z.object({
    kind: z.enum(EVENT_KINDS),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    accuracy: z.number().int().nonnegative().optional(),
    consent: z.boolean().default(false)
});

const listQuerySchema = z.object({
    employeeId: z.coerce.number().int().positive().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200)
});

const correctionRequestSchema = z.object({
    eventId: z.coerce.number().int().positive(),
    field: z.enum(['occurred_at', 'kind', 'geo']),
    newValue: z.record(z.string(), z.unknown()),
    reason: z.string().min(3).max(2000)
});

function rowToEvent(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        employeeId: row.employee_id,
        kind: row.kind,
        occurredAt: row.occurred_at,
        geo:
            row.geo_lat !== null && row.geo_lat !== undefined
                ? {
                      lat: Number(row.geo_lat),
                      lng: Number(row.geo_lng),
                      accuracyM: row.geo_accuracy_m ?? null,
                      consent: row.geo_consent
                  }
                : null,
        source: row.source,
        createdBy: row.created_by,
        createdAt: row.created_at
    };
}

function rowToCorrection(row: Record<string, unknown>) {
    return {
        id: Number(row.id),
        eventId: Number(row.event_id),
        employeeId: row.employee_id,
        requestedBy: row.requested_by,
        field: row.field,
        oldValue: row.old_value,
        newValue: row.new_value,
        reason: row.reason,
        status: row.status,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        createdAt: row.created_at
    };
}

/** Old-value snapshot for a correction request, keyed by the target field. */
function correctionOldValue(event: Record<string, unknown>, field: string): Record<string, unknown> {
    switch (field) {
        case 'occurred_at':
            return { occurredAt: event.occurred_at };
        case 'kind':
            return { kind: event.kind };
        case 'geo':
            return {
                lat: event.geo_lat,
                lng: event.geo_lng,
                accuracyM: event.geo_accuracy_m,
                consent: event.geo_consent
            };
        default:
            return {};
    }
}

export function attendanceRouter(deps: TimeDeps): Router {
    const { pool, publisher, log } = deps;
    const router = Router();

    // POST /v1/attendance/check — self-service punch (PWA). Geo is stored
    // only with explicit per-event consent; point-in-time, never tracked.
    router.post('/check', requireUser, async (req, res, next) => {
        try {
            const parsed = checkSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid check payload', parsed.error.issues);
            const body = parsed.data;
            const user = req.user as GatewayUser;

            const hasGeo = body.lat !== undefined || body.lng !== undefined || body.accuracy !== undefined;
            if (hasGeo) {
                if (body.lat === undefined || body.lng === undefined) {
                    throw httpError(400, 'Geo requires both lat and lng');
                }
                if (body.consent !== true) {
                    throw httpError(400, 'Geolocation requires explicit consent (consent=true)');
                }
            }

            // Idempotent-ish: a second check_in while a shift is still open
            // (no later check_out) is a conflict, not a duplicate row.
            if (body.kind === 'check_in') {
                const open = await pool.query(
                    `SELECT e.id FROM attendance_events e
                     WHERE e.employee_id = $1 AND e.kind = 'check_in'
                       AND NOT EXISTS (
                           SELECT 1 FROM attendance_events o
                           WHERE o.employee_id = e.employee_id AND o.kind = 'check_out'
                             AND o.occurred_at > e.occurred_at)
                     ORDER BY e.occurred_at DESC
                     LIMIT 1`,
                    [user.employeeId]
                );
                if (open.rows[0]) {
                    throw httpError(409, 'Open check-in already exists — check out first', {
                        openEventId: Number(open.rows[0].id)
                    });
                }
            }

            const { rows } = await pool.query(
                `INSERT INTO attendance_events
                    (employee_id, kind, occurred_at, geo_lat, geo_lng, geo_accuracy_m,
                     geo_consent, source, created_by)
                 VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, 'pwa', $8)
                 RETURNING *`,
                [
                    user.employeeId,
                    body.kind,
                    body.occurredAt ?? null,
                    hasGeo ? body.lat : null,
                    hasGeo ? body.lng : null,
                    hasGeo ? (body.accuracy ?? null) : null,
                    hasGeo === true
                ]
            );
            const event = rows[0];
            attendanceRecorded.inc({ kind: body.kind });
            await publisher.publish(
                AttendanceRecorded,
                'strafor.attendance.recorded',
                {
                    eventId: Number(event.id),
                    employeeId: user.employeeId,
                    kind: body.kind,
                    occurredAt: new Date(event.occurred_at).toISOString(),
                    source: 'pwa',
                    ...(hasGeo ? { geo: { lat: body.lat, lng: body.lng, accuracyM: body.accuracy } } : {})
                },
                req.correlationId
            );
            res.status(201).json(rowToEvent(event));
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/attendance/mine — own events (any employee-facing role).
    router.get('/mine', requireUser, async (req, res, next) => {
        try {
            const user = req.user as GatewayUser;
            const q = listQuerySchema.safeParse(req.query);
            if (!q.success) throw httpError(400, 'Invalid query', q.error.issues);
            const { rows } = await pool.query(
                `SELECT * FROM attendance_events
                 WHERE employee_id = $1
                   AND ($2::timestamptz IS NULL OR occurred_at >= $2)
                   AND ($3::timestamptz IS NULL OR occurred_at <= $3)
                 ORDER BY occurred_at DESC
                 LIMIT $4`,
                [user.employeeId, q.data.from ?? null, q.data.to ?? null, q.data.limit]
            );
            res.json({ events: rows.map(rowToEvent) });
        } catch (err) {
            next(err);
        }
    });

    // GET /v1/attendance/corrections — reviewers see all; employees see own.
    router.get('/corrections', requireUser, async (req, res, next) => {
        try {
            const user = req.user as GatewayUser;
            const reviewer = user.role === 'hr' || user.role === 'manager';
            const status = typeof req.query.status === 'string' ? req.query.status : null;
            const { rows } = await pool.query(
                `SELECT * FROM attendance_corrections
                 WHERE ($1::text IS NULL OR status = $1)
                   AND ($2::int IS NULL OR employee_id = $2)
                 ORDER BY created_at DESC
                 LIMIT 500`,
                [status, reviewer ? null : user.employeeId]
            );
            res.json({ corrections: rows.map(rowToCorrection) });
        } catch (err) {
            next(err);
        }
    });

    // POST /v1/attendance/corrections — request a change to an event.
    // Corrections are the ONLY mutation path for events; nothing here edits
    // attendance_events directly — approval applies the change in a tx.
    router.post('/corrections', requireUser, async (req, res, next) => {
        try {
            const parsed = correctionRequestSchema.safeParse(req.body);
            if (!parsed.success) throw httpError(400, 'Invalid correction request', parsed.error.issues);
            const body = parsed.data;
            const user = req.user as GatewayUser;

            const { rows } = await pool.query(`SELECT * FROM attendance_events WHERE id = $1`, [body.eventId]);
            const event = rows[0];
            if (!event) throw httpError(404, 'Attendance event not found');
            // Employees may only correct their own punches; hr may file for anyone.
            if (user.role !== 'hr' && event.employee_id !== user.employeeId) {
                throw httpError(403, 'Forbidden');
            }

            const inserted = await pool.query(
                `INSERT INTO attendance_corrections
                    (event_id, employee_id, requested_by, field, old_value, new_value, reason)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING *`,
                [
                    body.eventId,
                    event.employee_id,
                    user.userId,
                    body.field,
                    JSON.stringify(correctionOldValue(event, body.field)),
                    JSON.stringify(body.newValue),
                    body.reason
                ]
            );
            res.status(201).json(rowToCorrection(inserted.rows[0]));
        } catch (err) {
            next(err);
        }
    });

    const decideCorrection =
        (decision: 'approved' | 'rejected') =>
        async (
            req: import('express').Request,
            res: import('express').Response,
            next: import('express').NextFunction
        ) => {
            try {
                const id = Number(req.params.id);
                if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid correction id');
                const user = req.user as GatewayUser;

                const result = await withTransaction(pool, async (client) => {
                    const { rows } = await client.query(
                        `SELECT * FROM attendance_corrections WHERE id = $1 FOR UPDATE`,
                        [id]
                    );
                    const corr = rows[0];
                    if (!corr) throw httpError(404, 'Correction not found');
                    if (corr.status !== 'pending') {
                        throw httpError(409, `Correction already ${corr.status}`);
                    }

                    if (decision === 'approved') {
                        const nv = corr.new_value as Record<string, unknown>;
                        if (corr.field === 'occurred_at') {
                            const at = new Date(String(nv.occurredAt));
                            if (Number.isNaN(at.getTime())) {
                                throw httpError(422, 'Correction new_value.occurredAt is not a valid timestamp');
                            }
                            await client.query(
                                `UPDATE attendance_events
                                 SET occurred_at = $2, source = 'correction' WHERE id = $1`,
                                [corr.event_id, at.toISOString()]
                            );
                        } else if (corr.field === 'kind') {
                            if (!EVENT_KINDS.includes(nv.kind as never)) {
                                throw httpError(422, 'Correction new_value.kind is invalid');
                            }
                            await client.query(
                                `UPDATE attendance_events SET kind = $2, source = 'correction' WHERE id = $1`,
                                [corr.event_id, nv.kind]
                            );
                        } else if (corr.field === 'geo') {
                            if (nv.clear === true) {
                                await client.query(
                                    `UPDATE attendance_events SET geo_lat = NULL, geo_lng = NULL,
                                        geo_accuracy_m = NULL, geo_consent = false,
                                        source = 'correction' WHERE id = $1`,
                                    [corr.event_id]
                                );
                            } else {
                                const lat = Number(nv.lat);
                                const lng = Number(nv.lng);
                                const acc =
                                    nv.accuracyM === undefined || nv.accuracyM === null ? null : Number(nv.accuracyM);
                                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                                    throw httpError(422, 'Correction new_value needs numeric lat/lng');
                                }
                                // Geo on events still requires recorded consent.
                                if (nv.consent !== true) {
                                    throw httpError(422, 'Geo correction requires new_value.consent=true');
                                }
                                await client.query(
                                    `UPDATE attendance_events SET geo_lat = $2, geo_lng = $3,
                                        geo_accuracy_m = $4, geo_consent = true,
                                        source = 'correction' WHERE id = $1`,
                                    [corr.event_id, lat, lng, acc]
                                );
                            }
                        }
                    }

                    const updated = await client.query(
                        `UPDATE attendance_corrections
                         SET status = $2, reviewed_by = $3, reviewed_at = now()
                         WHERE id = $1 RETURNING *`,
                        [id, decision, user.userId]
                    );
                    return updated.rows[0];
                });

                log.info({ correctionId: id, decision, reviewer: user.userId }, 'correction decided');
                res.json(rowToCorrection(result));
            } catch (err) {
                next(err);
            }
        };

    // PUT /v1/attendance/corrections/:id/approve|reject — hr or manager.
    router.put('/corrections/:id/approve', requireReviewer, decideCorrection('approved'));
    router.put('/corrections/:id/reject', requireReviewer, decideCorrection('rejected'));

    // GET /v1/attendance — HR management feed: filter by employee/date range.
    router.get('/', requireHR, async (req, res, next) => {
        try {
            const q = listQuerySchema.safeParse(req.query);
            if (!q.success) throw httpError(400, 'Invalid query', q.error.issues);
            const { rows } = await pool.query(
                `SELECT * FROM attendance_events
                 WHERE ($1::int IS NULL OR employee_id = $1)
                   AND ($2::timestamptz IS NULL OR occurred_at >= $2)
                   AND ($3::timestamptz IS NULL OR occurred_at <= $3)
                 ORDER BY occurred_at DESC
                 LIMIT $4`,
                [q.data.employeeId ?? null, q.data.from ?? null, q.data.to ?? null, q.data.limit]
            );
            res.json({ events: rows.map(rowToEvent) });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
