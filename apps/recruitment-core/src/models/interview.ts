import { withId, withTransaction, type Queryable } from '../db.js';
import type { Pool } from 'pg';

// Interview lifecycle: scheduled → done | cancelled (terminal statuses may
// still receive scorecard/notes edits — no transition matrix is enforced
// beyond the enum; the wire contract is the CHECK constraint's twin).
export const INTERVIEW_STATUSES = new Set(['scheduled', 'done', 'cancelled']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// Read shape: interview row + display refs resolved locally (candidate fields
// from the join; interviewer/vacancy names via users_projection + vacancies).
const SELECT = `
    SELECT i.*,
           c.first_name AS candidate_first_name,
           c.last_name AS candidate_last_name,
           c.email AS candidate_email,
           v.title AS vacancy_title,
           (SELECT u.first_name || ' ' || u.last_name
            FROM users_projection u WHERE u.id = i.interviewer_user_id) AS interviewer_name
    FROM interviews i
    JOIN candidates c ON c.id = i.candidate_id
    LEFT JOIN vacancies v ON v.id = i.vacancy_id
`;

export interface InterviewCreateData {
    application_id: number;
    candidate_id: number;
    vacancy_id: number;
    scheduled_at: Date | string;
    duration_minutes: number;
    interviewer_user_id?: number | null;
    location_or_link?: string | null;
    notes?: string | null;
    created_by?: number | null;
}

export async function create(client: Queryable, data: InterviewCreateData): Promise<Row> {
    const { rows } = await client.query(
        `INSERT INTO interviews
            (application_id, candidate_id, vacancy_id, scheduled_at, duration_minutes,
             interviewer_user_id, location_or_link, status, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
            data.application_id,
            data.candidate_id,
            data.vacancy_id,
            data.scheduled_at,
            data.duration_minutes,
            data.interviewer_user_id ?? null,
            data.location_or_link ?? null,
            'scheduled',
            data.notes ?? null,
            data.created_by ?? null
        ]
    );
    const interview = rows[0];
    if (!interview) throw new Error('interview insert returned no row');
    return withId(interview);
}

export async function findById(db: Queryable, id: unknown): Promise<Row | null> {
    const { rows } = await db.query(`${SELECT} WHERE i.id = $1`, [id]);
    return withId(rows[0] || null);
}

export async function findByVacancy(db: Queryable, vacancyId: unknown): Promise<Row[]> {
    const { rows } = await db.query(`${SELECT} WHERE i.vacancy_id = $1 ORDER BY i.scheduled_at ASC`, [vacancyId]);
    return rows.map((r) => withId(r));
}

const UPDATABLE_FIELDS = new Set([
    'scheduled_at',
    'duration_minutes',
    'interviewer_user_id',
    'location_or_link',
    'status',
    'scorecard',
    'notes'
]);

// Whitelisted field update (reschedule / cancel / scorecard). Self-
// transactional unless the caller passes its own `client`.
export async function updateById(
    pool: Pool,
    interviewId: unknown,
    fields: Record<string, unknown>,
    { client = null }: { client?: Queryable | null } = {}
): Promise<Row | null> {
    if (client) {
        return updateByIdTx(client, interviewId, fields);
    }
    return withTransaction(pool, (c) => updateByIdTx(c, interviewId, fields));
}

async function updateByIdTx(
    client: Queryable,
    interviewId: unknown,
    fields: Record<string, unknown>
): Promise<Row | null> {
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    const rejected = keys.filter((k) => !UPDATABLE_FIELDS.has(k));
    if (rejected.length > 0) {
        const err = new Error(`Invalid interview update fields: ${rejected.join(', ')}`) as Error & {
            status?: number;
        };
        err.status = 400;
        throw err;
    }
    if (fields.status !== undefined) {
        const status = String(fields.status).toLowerCase();
        if (!INTERVIEW_STATUSES.has(status)) {
            const err = new Error(`Invalid interview status: ${status}`) as Error & { status?: number };
            err.status = 400;
            throw err;
        }
    }
    if (keys.length === 0) {
        return findById(client, interviewId);
    }

    const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    const values = keys.map((key) => (key === 'scorecard' ? JSON.stringify(fields[key]) : fields[key]));
    const { rows } = await client.query(
        `UPDATE interviews SET ${setClause}, updated_at = now()
         WHERE id = $1 RETURNING id`,
        [interviewId, ...values]
    );
    if (!rows[0]) return null;
    return findById(client, interviewId);
}
