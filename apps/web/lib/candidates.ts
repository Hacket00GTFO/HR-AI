import type { Candidate } from './schemas';
import { sendJson } from './http';

// Small shared helpers for the candidate screens.

export function candidateId(c: Pick<Candidate, 'id' | '_id'>): string {
    return String(c.id ?? c._id ?? '');
}

export function candidateName(c: Pick<Candidate, 'first_name' | 'last_name'>): string {
    return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '—';
}

/** Vacancy id of the application this row represents (null if unknown). */
export function candidateVacancyId(c: Pick<Candidate, 'applied_for'>): number | null {
    const af = c.applied_for;
    if (af == null) return null;
    if (typeof af === 'object') return Number(af._id) || null;
    const n = Number(af);
    return Number.isFinite(n) ? n : null;
}

export function candidateVacancyTitle(c: Pick<Candidate, 'applied_for'>): string | null {
    const af = c.applied_for;
    return af && typeof af === 'object' ? af.title : null;
}

export function candidateMatchScore(c: Pick<Candidate, 'ai_feedback_analysis'>): number | null {
    const s = c.ai_feedback_analysis?.match_score;
    return typeof s === 'number' ? s : null;
}

/** PUT /api/candidates/:id/status through the BFF proxy. Throws on non-2xx. */
export async function updateCandidateStatus(
    candidateId: string | number,
    status: 'pending' | 'interview' | 'accepted' | 'rejected',
    vacancyId?: number | null
): Promise<void> {
    const { res } = await sendJson(`/api/proxy/candidates/${candidateId}/status`, {
        method: 'PUT',
        body: { status, vacancy_id: vacancyId ?? undefined }
    });
    if (!res.ok) throw new Error(`status update failed: ${res.status}`);
}

/** mailto: link matching the legacy email templates. */
export function mailtoLink(email: string, subject: string, body: string): string {
    return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
