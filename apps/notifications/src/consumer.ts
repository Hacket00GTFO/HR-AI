import amqplib, { type ChannelModel, type ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import type { ServiceLogger } from '@strafor/node-common';
import { z } from 'zod';
import { queueNotification } from './notifyService.js';
import type { TemplatePayload } from './render.js';

const QUEUE_NAME = 'notifications.domain-events';

interface RoutedNotification {
    to: string;
    template: string;
    payload: TemplatePayload;
    locale: string;
    userId?: number | undefined;
    /** Producer-style key override; beats the evt:{correlationId} fallback. */
    idempotencyKey?: string | undefined;
}

type Payload = Record<string, unknown>;

/** Per-route context: config + logger for events without a natural recipient. */
export interface RouteContext {
    /** HR/approver mailbox for digest-style events (HR_NOTIFY_EMAIL env). */
    hrNotifyEmail?: string | undefined;
    log: ServiceLogger;
}

type RouteFn = (p: Payload, ctx: RouteContext) => RoutedNotification | null;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

/**
 * Best-effort recipient resolution across event payloads. Explicit
 * recipientEmail/email win; role-flavoured fields (candidate/employee/work/
 * approver email) are the fallback for events that carry a person plus ids.
 */
function pickEmail(p: Payload): string | undefined {
    // NB: `to` is intentionally NOT a recipient alias — payroll.period_status
    // payloads carry `to` as the target status of the transition.
    return (
        str(p.recipientEmail) ??
        str(p.email) ??
        str(p.candidateEmail) ??
        str(p.employeeEmail) ??
        str(p.workEmail) ??
        str(p.approverEmail) ??
        str(p.recipient)
    );
}

/** 'es' / 'es-MX' → the 'es' template rows; everything else → 'en'. */
const pickLocale = (p: Payload): string => (str(p.locale)?.toLowerCase().startsWith('es') ? 'es' : 'en');

const userIdProp = (p: Payload) => (num(p.userId) !== undefined ? { userId: num(p.userId) } : {});

// ---------------------------------------------------------------------------
// Loose payload contracts for the consumed domain-event families.
// z.object strips unknown keys (never rejects them) and every field is
// .nullish() — the contract check catches wrong-typed/malformed data while a
// merely missing attribute degrades to an empty template variable.
// ---------------------------------------------------------------------------

const optStr = z.string().nullish();
const optInt = z.number().int().nullish();
const optNum = z.number().nullish();

const emailFields = {
    recipientEmail: optStr,
    email: optStr,
    candidateEmail: optStr,
    employeeEmail: optStr,
    workEmail: optStr,
    approverEmail: optStr,
    name: optStr,
    locale: optStr,
    userId: optInt
};

const RecruitmentApplicationSubmitted = z.object({
    ...emailFields,
    applicationId: optInt,
    candidateId: optInt,
    vacancyId: optInt,
    vacancyTitle: optStr,
    appliedAt: optStr
});
const RecruitmentCandidateStatusChanged = z.object({
    ...emailFields,
    candidateId: optInt,
    applicationId: optInt,
    vacancyId: optInt,
    vacancyTitle: optStr,
    previousStatus: optStr,
    newStatus: optStr,
    changedBy: optInt
});
const RecruitmentVacancyPublished = z.object({
    ...emailFields,
    vacancyId: optInt,
    title: optStr,
    department: optStr,
    location: optStr,
    type: optStr,
    experienceLevel: optStr,
    publishedBy: optInt
});
const RecruitmentHiringDecision = z.object({
    ...emailFields,
    candidateId: optInt,
    applicationId: optInt,
    vacancyId: optInt,
    vacancyTitle: optStr,
    decision: optStr
});
const ServicesTicketCreated = z.object({
    ...emailFields,
    ticketId: optInt,
    employeeId: optInt,
    category: optStr,
    priority: optStr,
    status: optStr,
    slaDueAt: optStr
});
const ServicesTicketAssigned = z.object({
    ...emailFields,
    ticketId: optInt,
    employeeId: optInt,
    assigneeUserId: optInt,
    status: optStr,
    slaDueAt: optStr
});
const ServicesTicketResolved = z.object({
    ...emailFields,
    ticketId: optInt,
    employeeId: optInt,
    status: optStr
});
const ServicesExpenseSubmitted = z.object({
    ...emailFields,
    reportId: optInt,
    employeeId: optInt,
    total: optNum,
    currency: optStr
});
const ServicesExpenseDecided = z.object({
    ...emailFields,
    reportId: optInt,
    employeeId: optInt,
    decision: optStr,
    total: optNum,
    currency: optStr
});
const ServicesSurveyOpened = z.object({
    ...emailFields,
    surveyId: optInt,
    type: optStr,
    opensAt: optStr,
    closesAt: optStr
});
const ServicesSurveyClosed = z.object({
    ...emailFields,
    surveyId: optInt,
    type: optStr,
    respondents: optInt
});
const PayrollPeriodStatus = z.object({
    ...emailFields,
    periodId: optInt,
    frequency: optStr,
    from: optStr,
    to: optStr,
    actor: optStr
});
const PayrollReconciled = z.object({
    ...emailFields,
    periodId: optInt,
    compared: optInt,
    deltas: optInt
});
const HrEmployeeCreated = z.object({
    ...emailFields,
    employeeId: optInt,
    employeeNumber: optStr,
    status: optStr,
    hireDate: optStr
});
const HrEmployeeTerminated = z.object({
    ...emailFields,
    employeeId: optInt,
    employeeNumber: optStr,
    status: optStr,
    terminationDate: optStr,
    reason: optStr
});
const AttendanceRecorded = z.object({
    ...emailFields,
    eventId: optInt,
    employeeId: optInt,
    kind: optStr,
    occurredAt: optStr,
    source: optStr,
    anomaly: z.boolean().nullish(),
    anomalyReason: optStr
});

/** safeParse wrapper — contract violations are logged and skipped (null). */
function parsePayload<S extends z.ZodTypeAny>(
    schema: S,
    p: Payload,
    type: string,
    ctx: RouteContext
): z.infer<S> | null {
    const r = schema.safeParse(p);
    if (!r.success) {
        ctx.log.warn({ type, issues: r.error.issues }, 'event payload failed contract validation — skipped');
        return null;
    }
    return r.data as z.infer<S>;
}

/** Skip path for events that carry ids only and no mailbox applies. */
function idsOnlySkip(ctx: RouteContext, type: string): null {
    ctx.log.info({ type }, 'event carries ids only — no resolvable recipient, skipped');
    return null;
}

/**
 * Recipient for digest-style events: an explicit payload email wins, else the
 * configured HR mailbox (HR_NOTIFY_EMAIL). Unset → info log + skip.
 */
function hrMailbox(p: Payload, ctx: RouteContext, type: string): string | undefined {
    const to = pickEmail(p) ?? ctx.hrNotifyEmail;
    if (!to) {
        ctx.log.info({ type }, 'no recipient in payload and HR_NOTIFY_EMAIL unset — skipped');
    }
    return to;
}

/**
 * Domain event type → notification routing. Events without a resolvable
 * recipient return null (logged + acked, never requeued — a poisoned event
 * must not block the quorum queue).
 */
export const EVENT_ROUTES: Record<string, RouteFn> = {
    'strafor.application.submitted': (p) => {
        const to = pickEmail(p);
        if (!to) return null;
        return {
            to,
            template: 'application.received',
            payload: { name: str(p.name) ?? str(p.candidateName) ?? 'there', vacancyTitle: p.vacancyTitle },
            locale: 'en',
            ...(num(p.userId) !== undefined ? { userId: num(p.userId) } : {})
        };
    },
    'strafor.candidate.status_changed': (p) => {
        const to = pickEmail(p);
        if (!to) return null;
        return {
            to,
            template: 'application.status_changed',
            payload: { name: str(p.name) ?? 'there', status: p.newStatus },
            locale: 'en',
            ...(num(p.userId) !== undefined ? { userId: num(p.userId) } : {})
        };
    },
    'strafor.interview.scheduled': (p) => {
        const to = pickEmail(p);
        if (!to) return null;
        return {
            to,
            template: 'interview.scheduled',
            payload: {
                name: str(p.name) ?? 'there',
                vacancyTitle: p.vacancyTitle,
                scheduledAt: p.scheduledAt ?? p.interviewAt
            },
            locale: 'en',
            ...(num(p.userId) !== undefined ? { userId: num(p.userId) } : {})
        };
    },
    'strafor.auth.password_reset_requested': (p) => {
        const to = pickEmail(p);
        if (!to) return null;
        // resetUrl is a bearer credential: it rides in payload so the template
        // can render it, then gets scrubbed from notification_logs once the
        // row can no longer be delivered (see SENSITIVE_PAYLOAD_KEYS in
        // notifyService.ts — suppressed at insert, sent/failed by the worker).
        return {
            to,
            template: 'auth.password_reset',
            payload: { name: str(p.name) ?? 'there', resetUrl: p.resetUrl },
            locale: 'en',
            ...(num(p.userId) !== undefined ? { userId: num(p.userId) } : {})
        };
    },
    'strafor.notification.requested': (p) => {
        const to = pickEmail(p);
        const template = str(p.template);
        if (!to || !template) return null;
        return {
            to,
            template,
            payload: p.payload && typeof p.payload === 'object' ? (p.payload as TemplatePayload) : {},
            locale: str(p.locale) === 'es' ? 'es' : 'en',
            ...(num(p.userId) !== undefined ? { userId: num(p.userId) } : {})
        };
    },

    // ------------------------------------------------------------------
    // Recruitment-core canonical family (dual-published alongside the
    // legacy strafor.application.*/strafor.candidate.* types above).
    // ------------------------------------------------------------------
    'strafor.recruitment.application_submitted': (p, ctx) => {
        const type = 'strafor.recruitment.application_submitted';
        const d = parsePayload(RecruitmentApplicationSubmitted, p, type, ctx);
        if (!d) return null;
        const to = pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        return {
            to,
            template: 'recruitment.application_received',
            payload: { name: d.name ?? 'there', vacancyTitle: d.vacancyTitle, appliedAt: d.appliedAt },
            locale: pickLocale(d),
            // Same key the legacy strafor.application.submitted payload
            // carries (`application:{id}`) so the dual-published pair
            // collapses into a single send regardless of arrival order.
            ...(d.applicationId ? { idempotencyKey: `application:${d.applicationId}` } : {}),
            ...userIdProp(d)
        };
    },
    'strafor.recruitment.candidate_status_changed': (p, ctx) => {
        const type = 'strafor.recruitment.candidate_status_changed';
        const d = parsePayload(RecruitmentCandidateStatusChanged, p, type, ctx);
        if (!d) return null;
        const to = pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        return {
            to,
            template: 'recruitment.status_changed',
            payload: { name: d.name ?? 'there', status: d.newStatus, vacancyTitle: d.vacancyTitle },
            locale: pickLocale(d),
            ...userIdProp(d)
        };
    },
    // HR digest — a vacancy has no per-person recipient; goes to the
    // configured HR mailbox only (HR_NOTIFY_EMAIL), else skip-queue.
    'strafor.recruitment.vacancy_published': (p, ctx) => {
        const type = 'strafor.recruitment.vacancy_published';
        const d = parsePayload(RecruitmentVacancyPublished, p, type, ctx);
        if (!d) return null;
        const to = hrMailbox(d, ctx, type);
        if (!to) return null;
        return {
            to,
            template: 'recruitment.vacancy_published',
            payload: {
                title: d.title,
                department: d.department,
                location: d.location,
                type: d.type,
                experienceLevel: d.experienceLevel
            },
            locale: pickLocale(d)
        };
    },
    // To the candidate — wording stays neutral: the email announces that a
    // decision was recorded without revealing hired/rejected in the payload.
    'strafor.recruitment.hiring_decision_recorded': (p, ctx) => {
        const type = 'strafor.recruitment.hiring_decision_recorded';
        const d = parsePayload(RecruitmentHiringDecision, p, type, ctx);
        if (!d) return null;
        const to = pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        return {
            to,
            template: 'recruitment.hiring_decision',
            payload: { name: d.name ?? 'there', vacancyTitle: d.vacancyTitle },
            locale: pickLocale(d),
            ...userIdProp(d)
        };
    },

    // ------------------------------------------------------------------
    // HR-services (service-desk tickets, expenses, surveys).
    // ------------------------------------------------------------------
    'strafor.services.ticket_created': (p, ctx) => {
        const type = 'strafor.services.ticket_created';
        const d = parsePayload(ServicesTicketCreated, p, type, ctx);
        if (!d) return null;
        const to = pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        return {
            to,
            template: 'services.ticket_created',
            payload: {
                name: d.name ?? 'there',
                ticketId: d.ticketId,
                category: d.category,
                priority: d.priority,
                slaDueAt: d.slaDueAt
            },
            locale: pickLocale(d),
            ...userIdProp(d)
        };
    },
    'strafor.services.ticket_assigned': (p, ctx) => {
        const type = 'strafor.services.ticket_assigned';
        const d = parsePayload(ServicesTicketAssigned, p, type, ctx);
        if (!d) return null;
        const to = pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        return {
            to,
            template: 'services.ticket_assigned',
            payload: { name: d.name ?? 'there', ticketId: d.ticketId, slaDueAt: d.slaDueAt },
            locale: pickLocale(d),
            ...userIdProp(d)
        };
    },
    'strafor.services.ticket_resolved': (p, ctx) => {
        const type = 'strafor.services.ticket_resolved';
        const d = parsePayload(ServicesTicketResolved, p, type, ctx);
        if (!d) return null;
        const to = pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        return {
            to,
            template: 'services.ticket_resolved',
            payload: { name: d.name ?? 'there', ticketId: d.ticketId },
            locale: pickLocale(d),
            ...userIdProp(d)
        };
    },
    // To the approver: explicit approverEmail/email in the payload wins,
    // else the configured HR mailbox.
    'strafor.services.expense_submitted': (p, ctx) => {
        const type = 'strafor.services.expense_submitted';
        const d = parsePayload(ServicesExpenseSubmitted, p, type, ctx);
        if (!d) return null;
        const to = hrMailbox(d, ctx, type);
        if (!to) return null;
        return {
            to,
            template: 'services.expense_submitted',
            payload: { reportId: d.reportId, employeeId: d.employeeId, total: d.total, currency: d.currency },
            locale: pickLocale(d)
        };
    },
    'strafor.services.expense_decided': (p, ctx) => {
        const type = 'strafor.services.expense_decided';
        const d = parsePayload(ServicesExpenseDecided, p, type, ctx);
        if (!d) return null;
        const to = pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        const locale = pickLocale(d);
        // 'approved'/'rejected' render awkwardly inside a Spanish sentence —
        // hand the template a localized label, keep the raw code alongside.
        const decision =
            locale === 'es'
                ? d.decision === 'approved'
                    ? 'aprobado'
                    : d.decision === 'rejected'
                      ? 'rechazado'
                      : d.decision
                : d.decision;
        return {
            to,
            template: 'services.expense_decided',
            payload: {
                name: d.name ?? 'there',
                reportId: d.reportId,
                decision,
                decisionCode: d.decision,
                total: d.total,
                currency: d.currency
            },
            locale,
            ...userIdProp(d)
        };
    },
    'strafor.services.survey_opened': (p, ctx) => {
        const type = 'strafor.services.survey_opened';
        const d = parsePayload(ServicesSurveyOpened, p, type, ctx);
        if (!d) return null;
        const to = pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        return {
            to,
            template: 'services.survey_opened',
            payload: { name: d.name ?? 'there', surveyId: d.surveyId, surveyType: d.type, closesAt: d.closesAt },
            locale: pickLocale(d),
            ...userIdProp(d)
        };
    },
    'strafor.services.survey_closed': (p, ctx) => {
        const type = 'strafor.services.survey_closed';
        const d = parsePayload(ServicesSurveyClosed, p, type, ctx);
        if (!d) return null;
        const to = hrMailbox(d, ctx, type);
        if (!to) return null;
        return {
            to,
            template: 'services.survey_closed',
            payload: { surveyId: d.surveyId, surveyType: d.type, respondents: d.respondents },
            locale: pickLocale(d)
        };
    },

    // ------------------------------------------------------------------
    // Payroll-adapter — both are HR-mailbox digests.
    // ------------------------------------------------------------------
    'strafor.payroll.period_status': (p, ctx) => {
        const type = 'strafor.payroll.period_status';
        const d = parsePayload(PayrollPeriodStatus, p, type, ctx);
        if (!d) return null;
        const to = hrMailbox(d, ctx, type);
        if (!to) return null;
        return {
            to,
            template: 'payroll.period_status',
            payload: { periodId: d.periodId, frequency: d.frequency, from: d.from, to: d.to, actor: d.actor },
            locale: pickLocale(d)
        };
    },
    'strafor.payroll.reconciled': (p, ctx) => {
        const type = 'strafor.payroll.reconciled';
        const d = parsePayload(PayrollReconciled, p, type, ctx);
        if (!d) return null;
        const to = hrMailbox(d, ctx, type);
        if (!to) return null;
        return {
            to,
            template: 'payroll.reconciled',
            payload: { periodId: d.periodId, compared: d.compared, deltas: d.deltas },
            locale: pickLocale(d)
        };
    },

    // ------------------------------------------------------------------
    // HR-core employee lifecycle.
    // ------------------------------------------------------------------
    // Welcome email to the work email the payload carries — ids only → skip.
    'strafor.hr.employee_created': (p, ctx) => {
        const type = 'strafor.hr.employee_created';
        const d = parsePayload(HrEmployeeCreated, p, type, ctx);
        if (!d) return null;
        const to = str(d.workEmail) ?? pickEmail(d);
        if (!to) return idsOnlySkip(ctx, type);
        return {
            to,
            template: 'hr.employee_welcome',
            payload: { name: d.name ?? 'there', employeeNumber: d.employeeNumber, hireDate: d.hireDate },
            locale: pickLocale(d),
            ...userIdProp(d)
        };
    },
    'strafor.hr.employee_terminated': (p, ctx) => {
        const type = 'strafor.hr.employee_terminated';
        const d = parsePayload(HrEmployeeTerminated, p, type, ctx);
        if (!d) return null;
        const to = hrMailbox(d, ctx, type);
        if (!to) return null;
        return {
            to,
            template: 'hr.employee_terminated',
            payload: {
                employeeId: d.employeeId,
                employeeNumber: d.employeeNumber,
                status: d.status,
                terminationDate: d.terminationDate,
                reason: d.reason
            },
            locale: pickLocale(d)
        };
    },

    // ------------------------------------------------------------------
    // Time-attendance — every punch publishes, but only anomaly-flagged
    // events notify (HR mailbox); the rest skip silently at debug level.
    // ------------------------------------------------------------------
    'strafor.attendance.recorded': (p, ctx) => {
        const type = 'strafor.attendance.recorded';
        const d = parsePayload(AttendanceRecorded, p, type, ctx);
        if (!d) return null;
        if (d.anomaly !== true) {
            ctx.log.debug({ type }, 'attendance event without anomaly flag — skipped');
            return null;
        }
        const to = hrMailbox(d, ctx, type);
        if (!to) return null;
        return {
            to,
            template: 'attendance.anomaly',
            payload: {
                employeeId: d.employeeId,
                kind: d.kind,
                occurredAt: d.occurredAt,
                source: d.source,
                anomalyReason: d.anomalyReason
            },
            locale: pickLocale(d)
        };
    }
};

export const CONSUMED_EVENT_TYPES = Object.keys(EVENT_ROUTES);

export interface ConsumerHandle {
    close(): Promise<void>;
}

export interface ConsumerOptions {
    /** HR/approver mailbox for digest-style events (HR_NOTIFY_EMAIL env). */
    hrNotifyEmail?: string | undefined;
}

/**
 * Idempotency key for a routed event: a producer-supplied
 * payload.idempotencyKey wins, then the route's own derived key (used to
 * dedupe the dual-published recruitment families), then the envelope
 * correlationId — the delivery tag is the last-resort fallback.
 */
export function deriveIdempotencyKey(
    envelope: { correlationId?: string | undefined; payload?: Payload | undefined },
    deliveryTag: number,
    routedKey?: string | undefined
): string {
    return str(envelope.payload?.idempotencyKey) ?? routedKey ?? `evt:${envelope.correlationId ?? deliveryTag}`;
}

/**
 * Subscribe `notifications.domain-events` (quorum) to the domain.events topic
 * exchange for every routed event type. Broker absence is tolerated: the
 * connector retries in the background and the rest of the service keeps
 * running.
 */
export function startConsumer(
    url: string | undefined,
    exchange: string,
    pool: Pool,
    log: ServiceLogger,
    reconnectMs = 5000,
    opts: ConsumerOptions = {}
): ConsumerHandle {
    const routeCtx: RouteContext = { hrNotifyEmail: opts.hrNotifyEmail, log };
    let conn: ChannelModel | null = null;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    async function connect() {
        if (stopped || !url) return;
        try {
            conn = await amqplib.connect(url);
            conn.on('close', () => {
                conn = null;
                if (!stopped) schedule();
            });
            conn.on('error', (err: Error) => log.warn({ err: err.message }, 'rabbitmq consumer connection error'));
            const ch = await conn.createChannel();
            await ch.assertExchange(exchange, 'topic', { durable: true });
            await ch.assertQueue(QUEUE_NAME, {
                durable: true,
                arguments: { 'x-queue-type': 'quorum' }
            });
            for (const type of CONSUMED_EVENT_TYPES) {
                await ch.bindQueue(QUEUE_NAME, exchange, type);
            }
            await ch.consume(QUEUE_NAME, (msg: ConsumeMessage | null) => {
                if (!msg) return;
                void handle(msg)
                    .then(() => ch.ack(msg))
                    .catch((err) => {
                        log.error(
                            { err: err instanceof Error ? err.message : err },
                            'event handling failed — acked to avoid poison-loop'
                        );
                        ch.ack(msg); // never requeue: malformed events must not loop
                    });
            });
            log.info({ queue: QUEUE_NAME, types: CONSUMED_EVENT_TYPES }, 'rabbitmq consumer ready');
        } catch (err) {
            conn = null;
            log.warn({ err: err instanceof Error ? err.message : err }, 'rabbitmq consumer connect failed — retrying');
            schedule();
        }
    }

    function schedule() {
        if (stopped) return;
        timer = setTimeout(() => void connect(), reconnectMs);
        timer.unref();
    }

    async function handle(msg: ConsumeMessage) {
        let envelope: { type?: string; correlationId?: string; payload?: Payload };
        try {
            envelope = JSON.parse(msg.content.toString('utf8'));
        } catch {
            log.warn('dropping non-JSON event message');
            return;
        }
        const type = envelope.type;
        const route = type ? EVENT_ROUTES[type] : undefined;
        if (!route) {
            log.debug({ type }, 'unrouted event type — acked');
            return;
        }
        const routed = route(envelope.payload ?? {}, routeCtx);
        if (!routed) {
            log.warn({ type }, 'event has no resolvable recipient — skipped');
            return;
        }
        const idempotencyKey = deriveIdempotencyKey(envelope, msg.fields.deliveryTag, routed.idempotencyKey);
        const result = await queueNotification(pool, {
            to: routed.to,
            template: routed.template,
            payload: routed.payload,
            locale: routed.locale,
            idempotencyKey,
            userId: routed.userId ?? null,
            correlationId: envelope.correlationId ?? null
        });
        log.info(
            { type, id: result.id, status: result.status, replayed: result.replayed },
            'event routed to notification'
        );
    }

    void connect();
    return {
        async close() {
            stopped = true;
            if (timer) clearTimeout(timer);
            try {
                await conn?.close();
            } catch {
                /* ignore */
            }
        }
    };
}
