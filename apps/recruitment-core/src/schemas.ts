import { z } from 'zod';

// Ported verbatim (recruitment surface only) from the monolith's
// middleware/schemas.js — the wire contract must not drift.

// ---------- shared primitives ----------

// Route params come in as strings; DB ids are SERIAL integers.
export const idParam = z.object({
    id: z.coerce.number().int().positive()
});

const email = z.string().trim().toLowerCase().email().max(255);

// Canonical candidate statuses (lowercase, see routes/candidates.ts)
const candidateStatus = z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(['pending', 'interview', 'accepted', 'rejected']));

// Optional free-text cover letter (the candidate portal sends `cover_letter`
// on the apply form — apps/web/components/portal/candidate-apply-form.tsx).
// Stored on applications.cover_letter; HR-only, never in public responses or
// event payloads. '' (empty multipart field) normalizes to undefined → NULL.
const coverLetter = z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.string().trim().max(10000).optional()
);

// ---------- candidates ----------
// NOTE: multipart form — all fields arrive as strings, so coerce numbers.
export const candidateCreateBody = z
    .object({
        first_name: z.string().trim().min(1).max(100),
        last_name: z.string().trim().min(1).max(100),
        email,
        phone: z.string().trim().min(1).max(50),
        linkedin: z.string().trim().max(255).optional().nullable(),
        experience: z.coerce.number().int().min(0).max(100),
        education: z.string().trim().min(1).max(255),
        location: z.string().trim().min(1).max(255),
        skills: z.string().trim().min(1),
        applied_for: z.coerce.number().int().positive(),
        current_position: z.string().trim().max(255).optional().nullable(),
        applied_at: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.date().optional()),
        // Additive (extraction spec §8a): an HR client may pre-upload the
        // resume via documents-resumes and reference the document id here
        // instead of attaching a file to this request.
        resume_document_id: z.string().uuid().optional().nullable(),
        cover_letter: coverLetter
    })
    .strip();

// Status/feedback writes target the candidate's *application*. When a
// candidate has several, vacancy_id (or the legacy applied_for) picks which
// one; otherwise the most recent application is updated.
export const candidateStatusBody = z
    .object({
        status: candidateStatus,
        vacancy_id: z.coerce.number().int().positive().nullish(),
        applied_for: z.coerce.number().int().positive().nullish()
    })
    .strict();

export const candidateFeedbackBody = z
    .object({
        hiring_feedback: z.string().trim().min(1),
        ai_insights: z.string().optional().nullable(),
        vacancy_id: z.coerce.number().int().positive().nullish(),
        applied_for: z.coerce.number().int().positive().nullish()
    })
    .strict();

// ---------- public apply ----------
// Anonymous application from the careers site (POST /v1/public/apply).
// Multipart form — all fields arrive as strings, so coerce numbers.
// Same shape as candidateCreateBody minus applied_at (server-assigned).
export const publicApplyBody = z
    .object({
        first_name: z.string().trim().min(1).max(100),
        last_name: z.string().trim().min(1).max(100),
        email,
        phone: z.string().trim().min(1).max(50),
        linkedin: z.string().trim().max(255).optional().nullable(),
        experience: z.coerce.number().int().min(0).max(100),
        education: z.string().trim().min(1).max(255),
        location: z.string().trim().min(1).max(255),
        skills: z.string().trim().min(1),
        applied_for: z.coerce.number().int().positive(),
        current_position: z.string().trim().max(255).optional().nullable(),
        cover_letter: coverLetter
    })
    .strip();

// ---------- vacancies ----------
const salaryRange = z
    .object({
        min: z.coerce.number().nonnegative(),
        max: z.coerce.number().nonnegative(),
        currency: z.string().trim().min(1).max(10)
    })
    .strip();

export const vacancyCreateBody = z
    .object({
        title: z.string().trim().min(1).max(255),
        department: z.string().trim().min(1).max(100),
        location: z.string().trim().min(1).max(255),
        type: z.string().trim().min(1).max(50),
        description: z.string().trim().min(1),
        requirements: z.string().trim().min(1),
        responsibilities: z.string().trim().min(1),
        skills_required: z
            .array(z.string())
            .transform((arr) => arr.map((s) => s.trim()).filter(Boolean))
            .pipe(z.array(z.string().min(1)).min(1)),
        experience_level: z.string().trim().min(1).max(50),
        salary_range: salaryRange,
        benefits: z.array(z.string().trim().min(1)).optional(),
        remote_option: z.boolean().optional(),
        application_deadline: z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.date().nullable()),
        external_postings: z
            .object({
                linkedin: z.boolean().optional(),
                occ: z.boolean().optional()
            })
            .strip()
            .optional()
            .nullable()
    })
    .strip();

// Canonical vacancy lifecycle states (DB stores them capitalized — 'Active').
// Unified with the vacancies_status_check constraint in migration 0002:
// the API used to accept 'Paused' the DB rejected, and the DB allowed
// 'Archived' the API rejected. Input is case-normalized ('paused' → 'Paused').
export const VACANCY_STATUSES = ['Draft', 'Active', 'Paused', 'Closed', 'Archived'] as const;
const vacancyStatus = z
    .string()
    .trim()
    .transform((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .pipe(z.enum(VACANCY_STATUSES));

// PUT /v1/vacancies/:id — partial update. Same fields as create but all
// optional + a lifecycle `status`; at least one real key must be present
// (checked after .strip(), so a body of only unknown keys is also rejected).
export const vacancyUpdateBody = vacancyCreateBody
    .extend({ status: vacancyStatus.optional() })
    .partial()
    .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field must be provided' });

// GET /v1/candidates query — status/vacancy filters map straight onto
// Application.buildFiltered; `q` is a substring search over name/email/skills.
export const candidateListQuery = z
    .object({
        status: candidateStatus.optional(),
        vacancy_id: z.coerce.number().int().positive().optional(),
        applied_for: z.coerce.number().int().positive().optional(),
        q: z.string().trim().max(255).optional(),
        orderBy: z.string().trim().max(50).optional(),
        limit: z.coerce.number().int().positive().max(1000).optional()
    })
    .strip();

// GET /v1/candidates/:id/history query — optional vacancy disambiguation,
// same rule as the status/feedback writes.
export const candidateHistoryQuery = z
    .object({
        vacancy_id: z.coerce.number().int().positive().nullish(),
        applied_for: z.coerce.number().int().positive().nullish()
    })
    .strip();

// ---------- ai ----------
export const processFeedbackBody = z
    .object({
        candidateId: z.coerce.number().int().positive(),
        vacancyId: z.coerce.number().int().positive(),
        feedback: z.string().trim().min(1)
    })
    .strict();

// ---------- interviews ----------
export const interviewStatus = z.enum(['scheduled', 'done', 'cancelled']);

// Scorecard written when the interview completes: per-criterion 1-5 ratings
// plus free-text notes. Stored as interviews.scorecard JSONB.
const scorecardCriterion = z
    .object({
        name: z.string().trim().min(1).max(100),
        rating: z.coerce.number().int().min(1).max(5),
        notes: z.string().trim().max(2000).optional().nullable()
    })
    .strip();

export const interviewScorecard = z
    .object({
        criteria: z.array(scorecardCriterion).max(50).optional(),
        overall_rating: z.coerce.number().int().min(1).max(5).optional().nullable(),
        notes: z.string().trim().max(5000).optional().nullable()
    })
    .strip();

// POST /v1/vacancies/:id/interviews — the vacancy comes from the path; the
// interviewee is referenced by application_id (preferred) or candidate_id
// (resolved to the candidate's latest application on this vacancy).
// `duration` is accepted as an alias for `duration_minutes`.
export const interviewCreateBody = z
    .object({
        application_id: z.coerce.number().int().positive().optional(),
        candidate_id: z.coerce.number().int().positive().optional(),
        scheduled_at: z.coerce.date(),
        duration_minutes: z.coerce.number().int().min(1).max(1440).optional(),
        duration: z.coerce.number().int().min(1).max(1440).optional(),
        interviewer_user_id: z.coerce.number().int().positive().optional().nullable(),
        location_or_link: z.string().trim().max(500).optional().nullable(),
        notes: z.string().trim().max(5000).optional().nullable()
    })
    .strip()
    .transform((o) => {
        const { duration, ...rest } = o;
        return { ...rest, duration_minutes: o.duration_minutes ?? duration ?? 60 };
    })
    .refine((o) => o.application_id != null || o.candidate_id != null, {
        message: 'application_id or candidate_id is required'
    });

// PUT /v1/interviews/:id — partial update (reschedule, cancel, scorecard).
// `duration` alias accepted like on create.
export const interviewUpdateBody = z
    .object({
        scheduled_at: z.coerce.date().optional(),
        duration_minutes: z.coerce.number().int().min(1).max(1440).optional(),
        duration: z.coerce.number().int().min(1).max(1440).optional(),
        interviewer_user_id: z.coerce.number().int().positive().optional().nullable(),
        location_or_link: z.string().trim().max(500).optional().nullable(),
        status: interviewStatus.optional(),
        scorecard: interviewScorecard.optional().nullable(),
        notes: z.string().trim().max(5000).optional().nullable()
    })
    .strip()
    .transform((o) => {
        const { duration, ...rest } = o;
        const merged = o.duration_minutes ?? duration;
        // Keep absent keys absent — the PUT writer iterates own-keys.
        return merged !== undefined ? { ...rest, duration_minutes: merged } : rest;
    })
    .refine((o) => Object.values(o).some((v) => v !== undefined), {
        message: 'At least one field must be provided'
    });

// ---------- offers ----------
// POST /v1/applications/:id/offer — extend an offer to the application's
// candidate. status defaults to 'sent' (the offer is extended immediately);
// pass 'draft' to park it without sending.
export const offerCreateBody = z
    .object({
        salary: z.coerce.number().nonnegative(),
        salary_currency: z.string().trim().min(1).max(10).optional().nullable(),
        start_date: z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.date().nullable()),
        terms: z.string().trim().max(10000).optional().nullable(),
        status: z.enum(['draft', 'sent']).optional()
    })
    .strip();

// POST /v1/offers/:id/decision — the candidate's answer. Terminal offers
// (already accepted/declined/expired) are rejected with 409 by the model.
export const offerDecisionBody = z
    .object({
        decision: z.enum(['accepted', 'declined']),
        reason: z.string().trim().max(5000).optional().nullable()
    })
    .strict();
