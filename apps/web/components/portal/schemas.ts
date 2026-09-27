import { z } from 'zod';

// ── Employee self-service portal wire schemas ───────────────────────────────
// Verified upstream contracts (time-attendance service, via gateway):
//   POST /v1/attendance/check      { kind, occurredAt?, lat?, lng?, accuracy?, consent }
//   GET  /v1/attendance/mine       { events: AttendanceEvent[] }
//   GET  /v1/leave/types           { types: LeaveType[] }
//   GET/POST /v1/leave/requests    { requests: LeaveRequest[] } / LeaveRequest
//   PUT  /v1/leave/requests/:id/cancel
//   GET  /v1/leave/balances        { balances: LeaveBalance[] }
//
// NOT YET IMPLEMENTED upstream (no route in gateway table or monolith — the
// gateway falls through to the legacy monolith which 404s). The shapes below
// follow the documented portal contract and are deliberately `.loose()` so the
// UI keeps working once hr-services lands on ports 3011/3014:
//   GET/POST /v1/tickets           { tickets: Ticket[] } — own tickets only
//   GET  /v1/tickets/:id           { ticket, comments }  — assumed envelope
//   POST /v1/tickets/:id/comments  { body }              — assumed
//   GET/POST /v1/expenses          { reports: ExpenseReport[] }
//   GET  /v1/assets                { assets: Asset[] }   — own assignments

const idSchema = z.union([z.number(), z.string()]);
const isoOrNull = z.string().nullable().optional().default(null);

// ---------- attendance ----------

export const attendanceKindSchema = z.enum(['check_in', 'check_out', 'break_start', 'break_end']);
export type AttendanceKind = z.infer<typeof attendanceKindSchema>;

export const attendanceEventSchema = z
    .object({
        id: idSchema,
        employeeId: idSchema.optional(),
        kind: z.string(),
        occurredAt: z.string(),
        geo: z
            .object({
                lat: z.number(),
                lng: z.number(),
                accuracyM: z.number().nullable().optional(),
                consent: z.boolean().optional()
            })
            .loose()
            .nullable()
            .optional()
            .default(null),
        source: z.string().optional(),
        createdAt: z.string().optional()
    })
    .loose();
export type AttendanceEvent = z.infer<typeof attendanceEventSchema>;

export const attendanceMineResponseSchema = z.object({ events: z.array(attendanceEventSchema) }).loose();

/** POST /v1/attendance/check payload. Geo fields only allowed with consent=true. */
export const attendanceCheckBodySchema = z
    .object({
        kind: attendanceKindSchema,
        occurredAt: z.string().optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        accuracy: z.number().int().nonnegative().optional(),
        consent: z.boolean().default(false)
    })
    .refine((v) => (v.lat === undefined && v.lng === undefined) || (v.lat !== undefined && v.lng !== undefined), {
        message: 'geoPairRequired'
    })
    .refine((v) => v.lat === undefined || v.consent === true, { message: 'geoConsentRequired' });
export type AttendanceCheckBody = z.infer<typeof attendanceCheckBodySchema>;

// ---------- leave ----------

export const leaveTypeSchema = z
    .object({
        id: z.number(),
        code: z.string(),
        name: z.string(),
        paid: z.boolean().optional().default(true),
        requiresApproval: z.boolean().optional().default(true),
        accrual: z.unknown().optional()
    })
    .loose();
export type LeaveType = z.infer<typeof leaveTypeSchema>;

export const leaveTypesResponseSchema = z.object({ types: z.array(leaveTypeSchema) }).loose();

export const leaveRequestSchema = z
    .object({
        id: z.number(),
        employeeId: idSchema.optional(),
        leaveTypeId: z.number(),
        startDate: z.string(),
        endDate: z.string(),
        days: z.number(),
        status: z.string(),
        approverId: idSchema.nullable().optional().default(null),
        reason: z.string().nullable().optional().default(null),
        decidedAt: isoOrNull,
        createdAt: z.string().optional()
    })
    .loose();
export type LeaveRequest = z.infer<typeof leaveRequestSchema>;

export const leaveRequestsResponseSchema = z.object({ requests: z.array(leaveRequestSchema) }).loose();

export const leaveBalanceSchema = z
    .object({
        id: z.number().optional(),
        employeeId: idSchema.optional(),
        leaveTypeId: z.number(),
        year: z.number(),
        entitled: z.number(),
        used: z.number(),
        carried: z.number().optional().default(0),
        available: z.number()
    })
    .loose();
export type LeaveBalance = z.infer<typeof leaveBalanceSchema>;

export const leaveBalancesResponseSchema = z.object({ balances: z.array(leaveBalanceSchema) }).loose();

// ---------- tickets (contract assumed — service not deployed yet) ----------

export const ticketCommentSchema = z
    .object({
        id: idSchema.optional(),
        // hr-services comment body key not yet published — accept both.
        body: z.string().optional(),
        text: z.string().optional(),
        author: z.string().nullable().optional().default(null),
        author_name: z.string().nullable().optional().default(null),
        created_at: isoOrNull,
        createdAt: isoOrNull
    })
    .loose();
export type TicketComment = z.infer<typeof ticketCommentSchema>;

export const ticketSchema = z
    .object({
        id: idSchema,
        category: z.string().optional().default(''),
        subject: z.string().optional().default(''),
        title: z.string().optional().default(''),
        description: z.string().optional().default(''),
        status: z.string().optional().default('open'),
        priority: z.string().nullable().optional().default(null),
        created_at: isoOrNull,
        createdAt: isoOrNull,
        updated_at: isoOrNull,
        updatedAt: isoOrNull,
        comments: z.array(ticketCommentSchema).optional().default([])
    })
    .loose();
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketListResponseSchema = z.union([
    z.array(ticketSchema),
    z.object({ tickets: z.array(ticketSchema) }).loose(),
    z.object({ data: z.array(ticketSchema) }).loose()
]);

export const ticketDetailResponseSchema = z
    .object({
        ticket: ticketSchema.optional(),
        comments: z.array(ticketCommentSchema).optional().default([])
    })
    .loose();

// ---------- expenses (contract assumed — service not deployed yet) ----------

export const expenseItemSchema = z
    .object({
        id: idSchema.optional(),
        date: z.string().optional().default(''),
        category: z.string().optional().default(''),
        description: z.string().optional().default(''),
        amount: z.coerce.number().optional().default(0),
        currency: z.string().optional().default('MXN')
    })
    .loose();
export type ExpenseItem = z.infer<typeof expenseItemSchema>;

export const expenseReportSchema = z
    .object({
        id: idSchema,
        title: z.string().optional().default(''),
        name: z.string().optional().default(''),
        status: z.string().optional().default('draft'),
        currency: z.string().optional().default('MXN'),
        total: z.coerce.number().nullable().optional().default(null),
        items: z.array(expenseItemSchema).optional().default([]),
        submitted_at: isoOrNull,
        submittedAt: isoOrNull,
        created_at: isoOrNull,
        createdAt: isoOrNull
    })
    .loose();
export type ExpenseReport = z.infer<typeof expenseReportSchema>;

export const expenseListResponseSchema = z.union([
    z.array(expenseReportSchema),
    z.object({ reports: z.array(expenseReportSchema) }).loose(),
    z.object({ expenses: z.array(expenseReportSchema) }).loose(),
    z.object({ data: z.array(expenseReportSchema) }).loose()
]);

// ---------- assets (contract assumed — service not deployed yet) ----------

export const assetSchema = z
    .object({
        id: idSchema,
        tag: z.string().optional().default(''),
        asset_tag: z.string().optional().default(''),
        name: z.string().optional().default(''),
        type: z.string().optional().default(''),
        asset_type: z.string().optional().default(''),
        condition: z.string().nullable().optional().default(null),
        status: z.string().optional().default(''),
        assigned_since: isoOrNull,
        assignedSince: isoOrNull,
        assigned_at: isoOrNull
    })
    .loose();
export type Asset = z.infer<typeof assetSchema>;

export const assetListResponseSchema = z.union([
    z.array(assetSchema),
    z.object({ assets: z.array(assetSchema) }).loose(),
    z.object({ data: z.array(assetSchema) }).loose()
]);
