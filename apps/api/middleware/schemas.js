const { z } = require('zod');

// ---------- shared primitives ----------

// Route params come in as strings; DB ids are SERIAL integers.
const idParam = z.object({
    id: z.coerce.number().int().positive()
});

const email = z.string().trim().toLowerCase().email().max(255);
const password = z.string().min(6).max(200);
const locationObj = z
    .object({
        country: z.string().max(100).optional(),
        city: z.string().max(100).optional()
    })
    .strip();

const roleEnum = z.enum(['admin', 'hr']);

// Canonical candidate statuses (lowercase, see routes/candidates.js)
const candidateStatus = z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(['pending', 'interview', 'accepted', 'rejected']));

// ---------- auth ----------
const loginBody = z
    .object({
        email,
        password: z.string().min(1).max(200)
    })
    .strict();

const registerBody = z
    .object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        email,
        password,
        role: roleEnum,
        location: locationObj.optional()
    })
    .strict();

// Refresh/password flows — forwarded to identity-auth (see routes/auth.js).
const refreshBody = z
    .object({
        refreshToken: z.string().min(1).max(500)
    })
    .strict();

const forgotBody = z.object({ email }).strict();

const resetBody = z
    .object({
        token: z.string().min(1).max(500),
        newPassword: password
    })
    .strict();

const changePasswordBody = z
    .object({
        currentPassword: z.string().min(1).max(200),
        newPassword: password
    })
    .strict();

// ---------- candidates ----------
// NOTE: multipart form — all fields arrive as strings, so coerce numbers.
const candidateCreateBody = z
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
        applied_at: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.date().optional())
    })
    .strip();

// Status/feedback writes now target the candidate's *application*. When a
// candidate has several, vacancy_id (or the legacy applied_for) picks which
// one; otherwise the most recent application is updated.
const candidateStatusBody = z
    .object({
        status: candidateStatus,
        vacancy_id: z.coerce.number().int().positive().nullish(),
        applied_for: z.coerce.number().int().positive().nullish()
    })
    .strict();

const candidateFeedbackBody = z
    .object({
        hiring_feedback: z.string().trim().min(1),
        ai_insights: z.string().optional().nullable(),
        vacancy_id: z.coerce.number().int().positive().nullish(),
        applied_for: z.coerce.number().int().positive().nullish()
    })
    .strict();

// ---------- public apply ----------
// Anonymous application from the careers site (POST /api/public/apply).
// Multipart form — all fields arrive as strings, so coerce numbers.
// Same shape as candidateCreateBody minus applied_at (server-assigned).
const publicApplyBody = z
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
        current_position: z.string().trim().max(255).optional().nullable()
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

const vacancyCreateBody = z
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
const vacancyStatus = z.enum(['Active', 'Paused', 'Closed', 'Draft']);

// PUT /api/vacancies/:id — partial update. Same fields as create but all
// optional + a lifecycle `status`; at least one real key must be present
// (checked after .strip(), so a body of only unknown keys is also rejected).
const vacancyUpdateBody = vacancyCreateBody
    .extend({ status: vacancyStatus.optional() })
    .partial()
    .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field must be provided' });

// GET /api/candidates query — status/vacancy filters map straight onto
// Application.buildFiltered; `q` is a substring search over name/email/skills.
const candidateListQuery = z
    .object({
        status: candidateStatus.optional(),
        vacancy_id: z.coerce.number().int().positive().optional(),
        applied_for: z.coerce.number().int().positive().optional(),
        q: z.string().trim().max(255).optional(),
        orderBy: z.string().trim().max(50).optional(),
        limit: z.coerce.number().int().positive().max(1000).optional()
    })
    .strip();

// GET /api/candidates/:id/history query — optional vacancy disambiguation,
// same rule as the status/feedback writes.
const candidateHistoryQuery = z
    .object({
        vacancy_id: z.coerce.number().int().positive().nullish(),
        applied_for: z.coerce.number().int().positive().nullish()
    })
    .strip();

// ---------- ai ----------
const processFeedbackBody = z
    .object({
        candidateId: z.coerce.number().int().positive(),
        vacancyId: z.coerce.number().int().positive(),
        feedback: z.string().trim().min(1)
    })
    .strict();

// ---------- account management (admin) ----------
const accountCreateBody = z
    .object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        email,
        password,
        location: locationObj.optional().nullable()
    })
    .strict();

const accountUpdateBody = z
    .object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        email,
        password: password.optional(),
        location: locationObj.optional().nullable()
    })
    .strict();

// ---------- settings / user ----------
const companySettingsBody = z
    .object({
        name: z.string().trim().max(255).optional(),
        industry: z.string().trim().max(255).optional(),
        size: z.union([z.string().max(50), z.number()]).optional(),
        location: z.union([z.string().max(255), locationObj]).optional()
    })
    .strip();

const linkedinConfigBody = z
    .object({
        clientId: z.string().min(1).max(500),
        clientSecret: z.string().min(1).max(500),
        redirectUri: z.string().min(1).max(1000)
    })
    .strict();

const occConfigBody = z
    .object({
        apiKey: z.string().min(1).max(500),
        apiSecret: z.string().min(1).max(500),
        environment: z.string().max(50).optional()
    })
    .strict();

const profileUpdateBody = z
    .object({
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().min(1).max(100).optional(),
        location: locationObj.optional().nullable()
    })
    .strip();

// ---------- admin bulk operations ----------
// Ids are SERIAL ints; a bulk job over zero records is meaningless, so the
// id lists are required non-empty. Bounded to keep a single request from
// queueing unbounded work.
const bulkIdList = z.array(z.coerce.number().int().positive()).min(1).max(10000);

const bulkImportBody = z
    .object({
        total_records: z.coerce.number().int().nonnegative().optional()
    })
    .strip();

const bulkExportBody = z
    .object({
        columns: z.array(z.string().trim().min(1).max(100)).max(200).optional()
    })
    .strip();

const bulkStatusChangeBody = z
    .object({
        candidate_ids: bulkIdList,
        new_status: z.string().trim().min(1).max(50)
    })
    .strict();

const bulkEntityIdsBody = z
    .object({
        entity_type: z.string().trim().min(1).max(100),
        ids: bulkIdList
    })
    .strict();

module.exports = {
    idParam,
    loginBody,
    registerBody,
    refreshBody,
    forgotBody,
    resetBody,
    changePasswordBody,
    candidateCreateBody,
    publicApplyBody,
    candidateStatusBody,
    candidateFeedbackBody,
    candidateListQuery,
    candidateHistoryQuery,
    vacancyCreateBody,
    vacancyUpdateBody,
    vacancyStatus,
    processFeedbackBody,
    accountCreateBody,
    accountUpdateBody,
    companySettingsBody,
    linkedinConfigBody,
    occConfigBody,
    profileUpdateBody,
    bulkImportBody,
    bulkExportBody,
    bulkStatusChangeBody,
    bulkEntityIdsBody
};
