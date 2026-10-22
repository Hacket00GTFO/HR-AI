import { z } from 'zod';
import { eventEnvelope } from '@strafor/contracts/events/base.js';

// Time-attendance domain events. Kept local to the service (like
// contracts/events/document.js) — promote to @strafor/contracts when a
// second consumer needs them.

const geoPoint = z
    .object({
        lat: z.number(),
        lng: z.number(),
        accuracyM: z.number().int().nonnegative().optional()
    })
    .strict();

// POST /v1/attendance/check recorded a punch (or a correction applied one).
export const AttendanceRecorded = eventEnvelope(
    'strafor.attendance.recorded',
    1,
    z
        .object({
            eventId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            kind: z.enum(['check_in', 'check_out', 'break_start', 'break_end']),
            occurredAt: z.string().datetime({ offset: true }),
            source: z.enum(['pwa', 'manual', 'correction']),
            // Present only when the employee consented to geo on this event.
            geo: geoPoint.optional()
        })
        .strict()
);

// POST /v1/leave/requests created a request.
export const LeaveRequested = eventEnvelope(
    'strafor.leave.requested',
    1,
    z
        .object({
            requestId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            leaveType: z.string().min(1),
            startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            days: z.number().positive(),
            requiresApproval: z.boolean()
        })
        .strict()
);

// A leave request was approved / rejected / cancelled.
export const LeaveDecided = eventEnvelope(
    'strafor.leave.decided',
    1,
    z
        .object({
            requestId: z.number().int().positive(),
            employeeId: z.number().int().positive(),
            leaveType: z.string().min(1),
            decision: z.enum(['approved', 'rejected', 'cancelled']),
            approverId: z.number().int().positive().optional()
        })
        .strict()
);
