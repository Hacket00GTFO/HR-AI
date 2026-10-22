// Shared event-payload builders — both event families are published during
// the transition (docs/extraction/recruitment-core.md §5):
//   strafor.recruitment.*  — new canonical family
//   strafor.application.* / strafor.candidate.* — legacy shapes the existing
//     notifications consumer (apps/notifications/src/consumer.ts) routes on:
//     it reads payload.email, payload.name, payload.vacancyTitle,
//     payload.newStatus, payload.idempotencyKey.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function isoDate(v: unknown): string {
    if (v instanceof Date) return v.toISOString();
    return new Date((v as string | number | undefined) ?? Date.now()).toISOString();
}

function displayName(candidate: Row): string | undefined {
    const name = `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`.trim();
    return name || undefined;
}

/**
 * Payload pair for "application submitted". `application` only needs
 * { id, vacancy_id, applied_at }.
 */
export function applicationSubmittedPayloads(
    candidate: Row,
    application: Row,
    vacancyTitle: string | null,
    source: 'hr' | 'public'
) {
    const appliedAt = isoDate(application.applied_at);
    const recruitment = {
        applicationId: application.id,
        candidateId: candidate.id,
        vacancyId: application.vacancy_id,
        email: candidate.email,
        ...(candidate.resume_document_id ? { resumeDocumentId: candidate.resume_document_id } : {}),
        appliedAt
    };
    const legacy = {
        applicationId: application.id,
        candidateId: candidate.id,
        vacancyId: application.vacancy_id,
        email: candidate.email,
        name: displayName(candidate),
        vacancyTitle: vacancyTitle ?? undefined,
        appliedAt,
        hasResume: Boolean(candidate.resume_document_id || candidate.resume),
        ...(candidate.resume_document_id ? { resumeDocumentId: candidate.resume_document_id } : {}),
        source,
        idempotencyKey: `application:${application.id}`
    };
    return { recruitment, legacy };
}

/**
 * Payload for `strafor.interview.scheduled` — the type the notifications
 * consumer already routes on (apps/notifications/src/consumer.ts reads
 * email/name/vacancyTitle/scheduledAt). ids + display refs only: the
 * candidate email is the single piece of PII, required to send the invite.
 */
export function interviewScheduledPayload(
    interview: Row,
    ctx: {
        email?: string | null;
        name?: string | null;
        vacancyTitle?: string | null;
        interviewerName?: string | null;
    }
) {
    return {
        interviewId: interview.id,
        applicationId: interview.application_id,
        candidateId: interview.candidate_id,
        vacancyId: interview.vacancy_id,
        scheduledAt: isoDate(interview.scheduled_at),
        ...(interview.duration_minutes != null ? { durationMinutes: Number(interview.duration_minutes) } : {}),
        ...(interview.interviewer_user_id != null ? { interviewerUserId: interview.interviewer_user_id } : {}),
        ...(ctx.interviewerName ? { interviewerName: ctx.interviewerName } : {}),
        ...(interview.location_or_link ? { locationOrLink: interview.location_or_link } : {}),
        ...(ctx.email ? { email: ctx.email } : {}),
        ...(ctx.name ? { name: ctx.name } : {}),
        ...(ctx.vacancyTitle ? { vacancyTitle: ctx.vacancyTitle } : {}),
        idempotencyKey: `interview:${interview.id}`
    };
}

/**
 * Payload for `strafor.recruitment.offer_decided` — ids + decision only.
 * Compensation data (salary, terms) never leaves the service on the bus.
 */
export function offerDecidedPayload(offer: Row, application: Row | null, decidedBy: number | null) {
    return {
        offerId: offer.id,
        applicationId: offer.application_id,
        ...(application?.candidate_id != null ? { candidateId: application.candidate_id } : {}),
        ...(application?.vacancy_id != null ? { vacancyId: application.vacancy_id } : {}),
        decision: offer.status,
        ...(offer.decision_reason ? { reason: offer.decision_reason } : {}),
        ...(decidedBy ? { decidedBy } : {}),
        decidedAt: isoDate(offer.decided_at)
    };
}
