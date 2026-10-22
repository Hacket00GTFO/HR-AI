import { withId, type Queryable } from '../db.js';
import * as Application from './application.js';
import * as Skill from './skill.js';

// resume_document_id is additive on top of the legacy columns (the legacy
// `resume` filename column stays — RESUMES_DIR fallback for old rows).
const CANDIDATE_COLUMNS = `id, first_name, last_name, email, phone, linkedin, experience,
    education, location, skills, resume, resume_document_id, current_position, created_at, updated_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function normalizeEmail(email: unknown): string {
    return String(email || '')
        .trim()
        .toLowerCase();
}

// Candidate record only (no application context). For status/feedback use
// Application.resolveForCandidate / legacyRow.
export async function findById(db: Queryable, id: unknown): Promise<Row | null> {
    const { rows } = await db.query(
        `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE id = $1 AND deleted_at IS NULL`,
        [id]
    );
    return withId(rows[0] || null);
}

export async function findByEmail(db: Queryable, email: string): Promise<Row | null> {
    const { rows } = await db.query(
        `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE email = $1 AND deleted_at IS NULL`,
        [normalizeEmail(email)]
    );
    return withId(rows[0] || null);
}

export interface CandidateCreateData {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    linkedin?: string | null;
    experience: number;
    education: string;
    location: string;
    skills: string;
    resume?: string | null;
    resume_document_id?: string | null;
    current_position?: string | null;
    applied_for: number;
    applied_at?: Date;
    // Stored on the application row (applications.cover_letter), not the
    // candidate — a candidate may apply to several vacancies with different
    // letters.
    cover_letter?: string | null;
}

// Creates (or reuses, on email conflict) the candidate, then creates the
// application + initial status-history row + skills links — the caller owns
// the transaction so outbox events commit atomically with the writes.
// Returns the legacy wire shape: candidate fields + status/applied_at +
// applied_for populated as { _id, title }.
export async function createWithVacancy(
    client: Queryable,
    data: CandidateCreateData,
    { createdBy = null }: { createdBy?: number | null } = {}
): Promise<Row> {
    const email = normalizeEmail(data.email);
    const { rows } = await client.query(
        `INSERT INTO candidates (first_name, last_name, email, phone, linkedin, experience,
            education, location, skills, resume, resume_document_id, current_position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (email) DO NOTHING
         RETURNING ${CANDIDATE_COLUMNS}`,
        [
            data.first_name,
            data.last_name,
            email,
            data.phone,
            data.linkedin || null,
            data.experience,
            data.education,
            data.location,
            data.skills,
            data.resume || null,
            data.resume_document_id || null,
            data.current_position || null
        ]
    );
    let candidate = rows[0];
    if (!candidate) {
        // Email already registered — reuse the existing candidate and
        // attach the new application (emails are unique post-migration).
        candidate = (await client.query(`SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE email = $1`, [email]))
            .rows[0];
        if (!candidate) throw new Error('candidate upsert returned no row');
        // New resume uploaded for a returning candidate — refresh the
        // document link (the monolith kept the old file; the document
        // store makes the refresh cheap and keeps /:id/resume correct).
        if (data.resume_document_id && candidate.resume_document_id !== data.resume_document_id) {
            await client.query(`UPDATE candidates SET resume_document_id = $2, updated_at = now() WHERE id = $1`, [
                candidate.id,
                data.resume_document_id
            ]);
            candidate.resume_document_id = data.resume_document_id;
        }
    } else if (data.skills) {
        await Skill.syncCandidateSkills(client, candidate.id, data.skills);
    }

    const application = await Application.create(client, {
        candidate_id: candidate.id,
        vacancy_id: data.applied_for,
        status: 'pending',
        cover_letter: data.cover_letter ?? null,
        applied_at: data.applied_at || new Date(),
        created_by: createdBy
    });

    const vacancyTitle =
        (await client.query('SELECT title FROM vacancies WHERE id = $1', [data.applied_for])).rows[0]?.title ?? null;

    withId(candidate);
    return {
        ...candidate,
        application_id: application.id,
        status: application.status,
        applied_at: application.applied_at,
        applied_for: { _id: String(data.applied_for), title: vacancyTitle }
    };
}
