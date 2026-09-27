import { z } from 'zod';

// ---------- shared ----------

export const candidateStatusSchema = z.enum(['pending', 'interview', 'accepted', 'rejected']);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

// ---------- auth ----------

export const loginBodySchema = z.object({
    email: z.email(),
    password: z.string().min(1).max(200)
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const sessionUserSchema = z
    .object({
        id: z.union([z.number(), z.string()]).optional(),
        _id: z.union([z.number(), z.string()]).optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().optional(),
        role: z.string().optional()
    })
    .loose();
export type SessionUserWire = z.infer<typeof sessionUserSchema>;

/** legacy: POST {API_URL}/api/auth/login */
export const legacyLoginResponseSchema = z
    .object({
        token: z.string(),
        user: sessionUserSchema,
        message: z.string().optional()
    })
    .loose();

/** v1: POST {GATEWAY_URL}/api/v1/auth/login */
export const v1LoginResponseSchema = z
    .object({
        accessToken: z.string(),
        refreshToken: z.string().optional(),
        user: sessionUserSchema,
        mfa_setup_required: z.boolean().optional()
    })
    .loose();

/** v1 MFA challenge: POST /v1/auth/login returns this instead of tokens when MFA is on. */
export const mfaChallengeResponseSchema = z
    .object({
        mfa_required: z.literal(true),
        challenge_token: z.string().min(1),
        expires_in: z.number().optional()
    })
    .loose();

/** BFF body for POST /api/auth/mfa/verify → forwarded to /v1/auth/mfa/verify. */
export const mfaVerifyBodySchema = z
    .object({
        challenge_token: z.string().min(1),
        totp_code: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
        recovery_code: z.string().min(4).max(20).optional()
    })
    .refine((v) => v.totp_code !== undefined || v.recovery_code !== undefined, {
        message: 'code required'
    });

/** Enrollment endpoints: POST /v1/auth/mfa/setup and /confirm responses. */
export const mfaSetupResponseSchema = z
    .object({
        secret: z.string().min(1),
        qrCodeUrl: z.string().min(1)
    })
    .loose();
export const mfaConfirmResponseSchema = z
    .object({
        enabled: z.boolean(),
        recoveryCodes: z.array(z.string()).optional().default([])
    })
    .loose();

// ---------- vacancies ----------

export const salaryRangeSchema = z
    .object({
        min: z.number().nullable(),
        max: z.number().nullable(),
        currency: z.string().nullable()
    })
    .nullable();

export const vacancySchema = z
    .object({
        id: z.union([z.number(), z.string()]),
        _id: z.union([z.number(), z.string()]).optional(),
        title: z.string(),
        department: z.string().optional().default(''),
        location: z.string().optional().default(''),
        type: z.string().optional().default(''),
        description: z.string().optional().default(''),
        requirements: z.string().optional().default(''),
        responsibilities: z.string().optional().default(''),
        skills_required: z.array(z.string()).optional().default([]),
        experience_level: z.string().optional().default(''),
        salary_range: salaryRangeSchema.optional().default(null),
        benefits: z.array(z.string()).optional().default([]),
        remote_option: z.boolean().optional().default(false),
        application_deadline: z.string().nullable().optional().default(null),
        status: z.string().optional().default(''),
        created_at: z.string().optional()
    })
    .loose();
export type Vacancy = z.infer<typeof vacancySchema>;

export const vacancyListSchema = z.array(vacancySchema);

// ---------- dashboard ----------

export const activityItemSchema = z
    .object({
        type: z.string(),
        description: z.string(),
        timestamp: z.string(),
        icon: z.string().optional()
    })
    .loose();
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const trendPointSchema = z.object({
    date: z.string(),
    applications: z.number(),
    interviews: z.number()
});
export type TrendPoint = z.infer<typeof trendPointSchema>;

export const departmentStatSchema = z.object({
    name: z.string().nullable(),
    value: z.number()
});
export type DepartmentStat = z.infer<typeof departmentStatSchema>;

export const candidateRowSchema = z
    .object({
        id: z.union([z.number(), z.string()]),
        status: z.string().optional(),
        applied_at: z.string().optional()
    })
    .loose();

// ---------- internal: candidates ----------

// ai_feedback_analysis as produced by /api/ai/process-feedback and the
// vacancy candidate-list enrichment.
export const aiFeedbackAnalysisSchema = z
    .object({
        match_score: z.number().optional(),
        match_level: z.string().optional(),
        recommendation: z.string().optional(),
        summary: z.string().optional(),
        score_breakdown: z.record(z.string(), z.number()).optional(),
        red_flags: z.array(z.string()).optional(),
        source: z.string().optional(),
        feedback: z.string().optional()
    })
    .loose()
    .nullable();
export type AiFeedbackAnalysis = z.infer<typeof aiFeedbackAnalysisSchema>;

// One row per application with candidate fields merged in — the monolith's
// "legacy candidate view" (GET /api/candidates, GET /api/vacancies/:id/candidates).
export const candidateSchema = z
    .object({
        id: z.union([z.number(), z.string()]),
        _id: z.union([z.number(), z.string()]).optional(),
        application_id: z.union([z.number(), z.string()]).optional(),
        first_name: z.string().optional().default(''),
        last_name: z.string().optional().default(''),
        email: z.string().optional().default(''),
        phone: z.string().nullable().optional().default(null),
        linkedin: z.string().nullable().optional().default(null),
        experience: z.union([z.number(), z.string()]).nullable().optional().default(null),
        education: z.string().nullable().optional().default(null),
        location: z.string().nullable().optional().default(null),
        skills: z.string().nullable().optional().default(null),
        resume: z.string().nullable().optional().default(null),
        current_position: z.string().nullable().optional().default(null),
        status: z.string().optional().default('pending'),
        // int on vacancy-scoped endpoints, { _id, title } on GET /api/candidates
        applied_for: z
            .union([z.number(), z.string(), z.object({ _id: z.union([z.number(), z.string()]), title: z.string() })])
            .nullable()
            .optional()
            .default(null),
        applied_at: z.string().nullable().optional().default(null),
        hiring_feedback: z.string().nullable().optional().default(null),
        ai_insights: z.string().nullable().optional().default(null),
        ai_feedback_analysis: aiFeedbackAnalysisSchema.optional().default(null),
        feedback_timestamp: z.string().nullable().optional().default(null),
        needs_feedback: z.boolean().optional().default(false),
        created_at: z.string().optional()
    })
    .loose();
export type Candidate = z.infer<typeof candidateSchema>;
export const candidateListSchema = z.array(candidateSchema);

// GET /api/vacancies/:id/top-candidates — candidate row + ranking extras.
export const topCandidateSchema = candidateSchema.extend({
    match_score: z.number(),
    match_details: z
        .object({
            confidence: z.number().optional(),
            match_level: z.string().optional(),
            recommendation: z.string().optional(),
            score_breakdown: z.record(z.string(), z.number()).optional(),
            red_flags: z.array(z.string()).optional(),
            source: z.string().optional()
        })
        .loose()
        .nullish()
});
export type TopCandidate = z.infer<typeof topCandidateSchema>;
export const topCandidateListSchema = z.array(topCandidateSchema);

// GET /api/candidates/:id/history — application_status_history rows.
export const statusHistoryEntrySchema = z
    .object({
        id: z.union([z.number(), z.string()]).optional(),
        application_id: z.union([z.number(), z.string()]).optional(),
        from_status: z.string().nullable().optional().default(null),
        to_status: z.string().nullable().optional().default(null),
        changed_by: z.union([z.number(), z.string()]).nullable().optional().default(null),
        changed_at: z.string().nullable().optional().default(null),
        note: z.string().nullable().optional().default(null),
        changed_by_first_name: z.string().nullable().optional().default(null),
        changed_by_last_name: z.string().nullable().optional().default(null)
    })
    .loose();
export type StatusHistoryEntry = z.infer<typeof statusHistoryEntrySchema>;
export const statusHistorySchema = z.array(statusHistoryEntrySchema);

// POST /api/ai/process-feedback response.
export const processFeedbackResponseSchema = z
    .object({
        success: z.boolean().optional(),
        insights: aiFeedbackAnalysisSchema,
        candidate: candidateSchema.optional()
    })
    .loose();
export type ProcessFeedbackResponse = z.infer<typeof processFeedbackResponseSchema>;

// ---------- internal: account management (admin) ----------

// legacyUser() shape from the identity service proxy: camelCase + _id alias.
export const accountSchema = z
    .object({
        id: z.union([z.number(), z.string()]).optional(),
        _id: z.union([z.number(), z.string()]).optional(),
        firstName: z.string().optional().default(''),
        lastName: z.string().optional().default(''),
        email: z.string().optional().default(''),
        role: z.string().optional(),
        location: z
            .object({
                country: z.string().optional(),
                city: z.string().optional()
            })
            .nullable()
            .optional()
            .default(null),
        lastLogin: z.string().nullable().optional().default(null),
        createdAt: z.string().nullable().optional().default(null)
    })
    .loose();
export type Account = z.infer<typeof accountSchema>;
export const accountListSchema = z.array(accountSchema);

// ---------- internal: settings / profile ----------

export const userProfileSchema = z
    .object({
        id: z.union([z.number(), z.string()]).optional(),
        _id: z.union([z.number(), z.string()]).optional(),
        firstName: z.string().nullable().optional().default(null),
        lastName: z.string().nullable().optional().default(null),
        email: z.string().nullable().optional().default(null),
        role: z.string().nullable().optional().default(null),
        location: z
            .object({
                country: z.string().nullable().optional(),
                city: z.string().nullable().optional()
            })
            .nullable()
            .optional()
            .default(null)
    })
    .loose();
export type UserProfile = z.infer<typeof userProfileSchema>;

// GET /api/settings → identity /v1/settings passthrough.
export const settingsSchema = z
    .object({
        company: z
            .object({
                name: z.union([z.string(), z.number()]).nullable().optional(),
                industry: z.string().nullable().optional(),
                size: z.union([z.string(), z.number()]).nullable().optional(),
                location: z
                    .union([z.string(), z.record(z.string(), z.unknown())])
                    .nullable()
                    .optional()
            })
            .nullable()
            .optional(),
        theme: z.string().nullable().optional(),
        notifications: z.boolean().nullable().optional()
    })
    .loose();
export type Settings = z.infer<typeof settingsSchema>;

// ---------- public apply ----------

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const RESUME_MIME_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
] as const;

// Client-side apply form schema (browser File API). The server route handler
// re-validates fields and forwards to POST {API}/api/public/apply.
export const applyFormSchema = z.object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    email: z.email().max(255),
    phone: z.string().trim().min(1).max(50),
    linkedin: z.union([z.literal(''), z.string().trim().max(255)]),
    experience: z.coerce.number().int().min(0).max(100),
    education: z.string().trim().min(1).max(255),
    country: z.string().trim().min(1).max(100),
    state: z.string().trim().max(100),
    skills: z.array(z.string().trim().min(1)).min(1),
    current_position: z.string().trim().max(255),
    resume: z
        .custom<File>((v) => typeof File !== 'undefined' && v instanceof File)
        .optional()
        .nullable()
        .refine((f) => !f || f.size <= MAX_RESUME_BYTES, { message: 'resumeTooLarge' })
        .refine(
            (f) => !f || (RESUME_MIME_TYPES as readonly string[]).includes(f.type) || /\.(pdf|docx)$/i.test(f.name),
            { message: 'resumeBadType' }
        )
});
export type ApplyFormValues = z.infer<typeof applyFormSchema>;

// Server-side re-validation of the multipart text fields (matches
// apps/api publicApplyBody, minus applied_for which arrives from the route).
export const applyBodySchema = z.object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    email: z.email().max(255),
    phone: z.string().trim().min(1).max(50),
    linkedin: z.string().trim().max(255).optional().nullable(),
    experience: z.coerce.number().int().min(0).max(100),
    education: z.string().trim().min(1).max(255),
    location: z.string().trim().min(1).max(255),
    skills: z.string().trim().min(1),
    applied_for: z.coerce.number().int().positive(),
    current_position: z.string().trim().max(255).optional().nullable()
});
export type ApplyBody = z.infer<typeof applyBodySchema>;

export const applyResponseSchema = z.object({
    application_id: z.number().optional(),
    message: z.string()
});

// ── Admin dashboard ─────────────────────────────────────────────────────────
export const adminRecentAccountSchema = z.object({
    id: z.coerce.number(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
    active: z.boolean().optional().nullable(),
    updatedAt: z.string().optional().nullable()
});
export type AdminRecentAccount = z.infer<typeof adminRecentAccountSchema>;

export const adminSummarySchema = z.object({
    hrAccounts: z.coerce.number(),
    adminAccounts: z.coerce.number(),
    dbOk: z.boolean(),
    recentAccounts: z.array(adminRecentAccountSchema)
});
export type AdminSummary = z.infer<typeof adminSummarySchema>;

export const auditItemSchema = z.object({
    id: z.coerce.number().or(z.string()),
    action: z.string(),
    entity: z.string(),
    entityId: z.coerce.number().optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
    actorId: z.coerce.number().optional().nullable(),
    actorRole: z.string().optional().nullable(),
    timestamp: z.string()
});
export type AuditItem = z.infer<typeof auditItemSchema>;

// ── Phase 1: Admin panel schemas ─────────────────────────────────────────────

// 1.1 Service Health
export const serviceHealthSchema = z.object({
    name: z.string(),
    status: z.enum(['healthy', 'degraded', 'down']),
    latencyMs: z.number().optional(),
    url: z.string().optional(),
    error: z.string().optional()
});
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

export const healthSummarySchema = z.object({
    services: z.array(serviceHealthSchema),
    summary: z.object({
        total: z.number(),
        healthy: z.number(),
        degraded: z.number(),
        down: z.number()
    })
});
export type HealthSummary = z.infer<typeof healthSummarySchema>;

// 1.2 Background Jobs
export const jobExecutionSchema = z.object({
    id: z.union([z.number(), z.string()]),
    queue: z.string(),
    job_type: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'retry']),
    payload: z.unknown().optional().nullable(),
    error: z.string().optional().nullable(),
    attempts: z.number().optional().default(0),
    max_attempts: z.number().optional().default(3),
    created_at: z.string().optional(),
    started_at: z.string().optional().nullable(),
    completed_at: z.string().optional().nullable()
});
export type JobExecution = z.infer<typeof jobExecutionSchema>;

export const jobStatsSchema = z.object({
    total: z.number(),
    pending: z.number(),
    running: z.number(),
    completed: z.number(),
    failed: z.number(),
    byQueue: z.array(z.object({ queue: z.string(), count: z.number() }))
});
export type JobStats = z.infer<typeof jobStatsSchema>;

// 1.3 Audit Log (extended)
export const auditLogRowSchema = z.object({
    id: z.union([z.number(), z.string()]),
    action: z.string(),
    entity: z.string(),
    entityId: z.coerce.number().optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
    actorId: z.coerce.number().optional().nullable(),
    actorRole: z.string().optional().nullable(),
    timestamp: z.string()
});
export type AuditLogRow = z.infer<typeof auditLogRowSchema>;

export const auditLogResponseSchema = z.object({
    data: z.array(auditLogRowSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number()
});
export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;

export const auditStatsSchema = z.object({
    total: z.number(),
    topActions: z.array(z.object({ action: z.string(), count: z.number() })),
    topActors: z.array(z.object({ actor: z.string(), count: z.number() })),
    entities: z.array(z.object({ entity: z.string(), count: z.number() })),
    eventsByDay: z.array(z.object({ date: z.string(), count: z.number() }))
});
export type AuditStats = z.infer<typeof auditStatsSchema>;

// 1.4 Analytics Platform
export const analyticsOverviewSchema = z.object({
    totalVacancies: z.coerce.number(),
    activeVacancies: z.coerce.number(),
    totalCandidates: z.coerce.number(),
    totalApplications: z.coerce.number(),
    applicationsLast30Days: z.coerce.number(),
    hiredCandidates: z.coerce.number(),
    funnel: z.array(z.object({ status: z.string(), count: z.coerce.number() })),
    vacanciesByDepartment: z.array(z.object({ department: z.string(), count: z.coerce.number() }))
});
export type AnalyticsOverview = z.infer<typeof analyticsOverviewSchema>;

export const analyticsTrendSchema = z.object({
    metric: z.string(),
    period: z.string(),
    data: z.array(z.object({ date: z.string(), value: z.coerce.number() }))
});
export type AnalyticsTrend = z.infer<typeof analyticsTrendSchema>;

// ---------- monitoring ----------

export const monitoringOverviewSchema = z.object({
    containers: z.object({
        total: z.number(),
        up: z.number(),
        down: z.number()
    }),
    cpuTotalPercent: z.number(),
    memoryTotalBytes: z.number(),
    rps: z.number(),
    errorRatio: z.number(),
    alertsFiring: z.number()
});
export type MonitoringOverview = z.infer<typeof monitoringOverviewSchema>;

export const containerSchema = z.object({
    container: z.string(),
    service: z.string(),
    memoryBytes: z.number(),
    cpuPercent: z.number(),
    restarts1h: z.number(),
    probeSuccess: z.number().nullable()
});
export type ContainerInfo = z.infer<typeof containerSchema>;

export const containerListSchema = z.object({
    containers: z.array(containerSchema)
});

export const seriesPointSchema = z.object({
    ts: z.number(),
    value: z.number()
});
export type SeriesPoint = z.infer<typeof seriesPointSchema>;

export const containerSeriesSchema = z.object({
    container: z.string(),
    range: z.string(),
    series: z.object({
        cpu: z.array(seriesPointSchema),
        memory: z.array(seriesPointSchema),
        memoryLimit: z.array(seriesPointSchema),
        netRx: z.array(seriesPointSchema),
        netTx: z.array(seriesPointSchema),
        fsRead: z.array(seriesPointSchema),
        fsWrite: z.array(seriesPointSchema)
    })
});
export type ContainerSeries = z.infer<typeof containerSeriesSchema>;

export const sparklinesSchema = z.object({
    sparklines: z.record(
        z.string(),
        z
            .object({
                cpu: z.array(seriesPointSchema).optional(),
                memory: z.array(seriesPointSchema).optional()
            })
            .loose()
    ),
    range: z.string()
});
export type Sparklines = z.infer<typeof sparklinesSchema>;

export const serviceRedSchema = z.object({
    service: z.string(),
    rps: z.number(),
    errorRatio: z.number(),
    p50: z.number(),
    p95: z.number(),
    p99: z.number()
});
export type ServiceRed = z.infer<typeof serviceRedSchema>;

export const servicesRedSchema = z.object({
    services: z.array(serviceRedSchema)
});

export const targetSchema = z.object({
    job: z.string(),
    instance: z.string(),
    health: z.string(),
    lastError: z.string(),
    lastScrape: z.string()
});
export type TargetInfo = z.infer<typeof targetSchema>;

export const targetsSchema = z.object({
    targets: z.array(targetSchema)
});

export const grafanaLinksSchema = z.object({
    grafanaPath: z.string(),
    dashboards: z.record(
        z.string(),
        z
            .object({
                uid: z.string(),
                panels: z.record(z.string(), z.number()).optional()
            })
            .loose()
    )
});
export type GrafanaLinks = z.infer<typeof grafanaLinksSchema>;

// ---------- alerts ----------

export const alertSchema = z
    .object({
        id: z.number(),
        fingerprint: z.string(),
        alertname: z.string(),
        severity: z.string(),
        service: z.string().nullable(),
        container: z.string().nullable(),
        status: z.string(),
        starts_at: z.string(),
        ends_at: z.string().nullable(),
        summary: z.string(),
        description: z.string(),
        acknowledged_by: z.number().nullable(),
        acknowledged_at: z.string().nullable(),
        created_at: z.string(),
        updated_at: z.string()
    })
    .loose();
export type AlertInfo = z.infer<typeof alertSchema>;

export const alertListSchema = z.object({
    alerts: z.array(alertSchema)
});

export const alertCountSchema = z.object({
    firing: z.number(),
    critical: z.number(),
    warning: z.number()
});
export type AlertCount = z.infer<typeof alertCountSchema>;
