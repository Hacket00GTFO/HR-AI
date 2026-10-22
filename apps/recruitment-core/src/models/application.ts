import { withId, withTransaction, type Queryable } from '../db.js';
import type { Pool } from 'pg';

export const APPLICATION_STATUSES = new Set(['pending', 'interview', 'accepted', 'rejected']);

// "Legacy candidate view": one row per application with the candidate fields
// merged in. This preserves the pre-split wire shape — status,
// hiring_feedback, ai_feedback_analysis, applied_at and applied_for used to
// live on candidates; they now come from applications.
// resume_document_id is additive (new column — the legacy `resume` filename
// column is still selected for old rows).
const LEGACY_SELECT = `
    SELECT
        c.id, c.first_name, c.last_name, c.email, c.phone, c.linkedin,
        c.experience, c.education, c.location, c.skills, c.resume,
        c.resume_document_id,
        c.current_position, c.created_at, c.updated_at,
        a.id AS application_id,
        a.vacancy_id AS applied_for,
        a.status, a.cover_letter, a.hiring_feedback, a.ai_insights, a.ai_feedback_analysis,
        a.feedback_timestamp, a.applied_at,
        v.title AS vacancy_title
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
    LEFT JOIN vacancies v ON v.id = a.vacancy_id
    WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL
`;

// ORDER BY whitelist — never interpolate request-controlled identifiers.
const SORTABLE: Record<string, string> = {
    applied_at: 'a.applied_at',
    status: 'a.status',
    first_name: 'c.first_name',
    last_name: 'c.last_name',
    experience: 'c.experience',
    email: 'c.email',
    created_at: 'c.created_at',
    updated_at: 'c.updated_at'
};

const UPDATABLE_FIELDS = new Set([
    'status',
    'hiring_feedback',
    'ai_insights',
    'ai_feedback_analysis',
    'feedback_timestamp',
    'applied_at'
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function safeOrderBy(orderBy: unknown, fallback = 'a.applied_at DESC'): string {
    const [col, dir] = String(orderBy || '')
        .trim()
        .split(/\s+/);
    const target = col ? SORTABLE[col] : undefined;
    if (!target) return fallback;
    return `${target} ${String(dir || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`;
}

function safeLimit(limit: unknown): number | null {
    const n = Number(limit);
    return Number.isInteger(n) && n > 0 && n <= 1000 ? n : null;
}

export interface ApplicationFilters {
    applied_for?: unknown;
    vacancy_id?: unknown;
    candidate_id?: unknown;
    status?: unknown;
    appliedAfter?: unknown;
    appliedBefore?: unknown;
}

function buildFiltered(filters: ApplicationFilters = {}, { orderBy = 'applied_at DESC', limit = null } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.applied_for !== undefined) {
        params.push(filters.applied_for);
        where.push(`a.vacancy_id = $${params.length}`);
    }
    if (filters.vacancy_id !== undefined) {
        params.push(filters.vacancy_id);
        where.push(`a.vacancy_id = $${params.length}`);
    }
    if (filters.candidate_id !== undefined) {
        params.push(filters.candidate_id);
        where.push(`a.candidate_id = $${params.length}`);
    }
    if (filters.status !== undefined) {
        params.push(filters.status);
        where.push(`a.status = $${params.length}`);
    }
    if (filters.appliedAfter) {
        params.push(filters.appliedAfter);
        where.push(`a.applied_at >= $${params.length}`);
    }
    if (filters.appliedBefore) {
        params.push(filters.appliedBefore);
        where.push(`a.applied_at <= $${params.length}`);
    }

    let sql = `${LEGACY_SELECT}${where.length ? ' AND ' + where.join(' AND ') : ''} ORDER BY ${safeOrderBy(orderBy)}`;
    const safe = safeLimit(limit);
    if (safe) {
        params.push(safe);
        sql += ` LIMIT $${params.length}`;
    }
    return { sql, params };
}

function toLegacyRow(row: Row): Row {
    // Strip the join helper column; applied_for stays the vacancy id (int),
    // exactly like the old candidates.applied_for column.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure used to omit the column
    const { vacancy_title, ...rest } = row;
    return withId(rest);
}

function toLegacyRowWithVacancy(row: Row): Row {
    const { vacancy_title, ...rest } = row;
    withId(rest);
    rest.applied_for = rest.applied_for != null ? { _id: String(rest.applied_for), title: vacancy_title } : null;
    return rest;
}

// One row per application, legacy candidate shape (applied_for = int).
export async function find(db: Queryable, filters: ApplicationFilters = {}, opts = {}): Promise<Row[]> {
    const { sql, params } = buildFiltered(filters, opts);
    const { rows } = await db.query(sql, params);
    return rows.map(toLegacyRow);
}

// Same, but applied_for is populated as { _id, title } — this is what
// GET /v1/candidates and the dashboard activity feed consume.
export async function findWithVacancyTitle(db: Queryable, filters: ApplicationFilters = {}, opts = {}): Promise<Row[]> {
    const { sql, params } = buildFiltered(filters, opts);
    const { rows } = await db.query(sql, params);
    return rows.map(toLegacyRowWithVacancy);
}

export async function findForVacancy(db: Queryable, vacancyId: unknown, opts = {}): Promise<Row[]> {
    return find(db, { applied_for: vacancyId }, opts);
}

// Canonical nested shape: application fields (incl. cover_letter — HR-only)
// at the top level, the candidate nested inside. Shared by
// findDetailedByVacancy and findDetailById.
function toDetailed(row: Row): Row {
    const {
        candidate_id,
        first_name,
        last_name,
        email,
        phone,
        linkedin,
        experience,
        education,
        location,
        skills,
        resume,
        resume_document_id,
        current_position,
        ...app
    } = row;
    return {
        ...app,
        _id: String(app.id),
        candidate: {
            id: candidate_id,
            _id: String(candidate_id),
            first_name,
            last_name,
            email,
            phone,
            linkedin,
            experience,
            education,
            location,
            skills,
            resume,
            resume_document_id,
            current_position
        }
    };
}

const DETAIL_SELECT = `
    SELECT a.id, a.vacancy_id, a.status, a.cover_letter, a.hiring_feedback, a.ai_insights,
            a.ai_feedback_analysis, a.feedback_timestamp, a.applied_at,
            a.created_by, a.created_at, a.updated_at,
            c.id AS candidate_id, c.first_name, c.last_name, c.email,
            c.phone, c.linkedin, c.experience, c.education, c.location,
            c.skills, c.resume, c.resume_document_id, c.current_position
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
`;

// Canonical nested shape used by GET /v1/vacancies/:id/applications.
export async function findDetailedByVacancy(db: Queryable, vacancyId: unknown): Promise<Row[]> {
    const { rows } = await db.query(
        `${DETAIL_SELECT}
         WHERE a.vacancy_id = $1 AND a.deleted_at IS NULL AND c.deleted_at IS NULL
         ORDER BY a.applied_at DESC`,
        [vacancyId]
    );
    return rows.map(toDetailed);
}

// Single application detail (GET /v1/applications/:id — HR only).
export async function findDetailById(db: Queryable, id: unknown): Promise<Row | null> {
    const { rows } = await db.query(
        `${DETAIL_SELECT}
         WHERE a.id = $1 AND a.deleted_at IS NULL AND c.deleted_at IS NULL`,
        [id]
    );
    return rows[0] ? toDetailed(rows[0]) : null;
}

export async function findById(db: Queryable, id: unknown): Promise<Row | null> {
    const { rows } = await db.query('SELECT * FROM applications WHERE id = $1 AND deleted_at IS NULL', [id]);
    return withId(rows[0] || null);
}

// Resolve which application a candidate-level write should hit: an explicit
// vacancy when given, otherwise the most recent live application.
export async function resolveForCandidate(
    db: Queryable,
    candidateId: unknown,
    vacancyId?: unknown
): Promise<Row | null> {
    const params: unknown[] = [candidateId];
    let sql = `SELECT * FROM applications
               WHERE candidate_id = $1 AND deleted_at IS NULL`;
    if (vacancyId !== undefined && vacancyId !== null) {
        params.push(vacancyId);
        sql += ` AND vacancy_id = $${params.length}`;
    }
    sql += ' ORDER BY applied_at DESC, id DESC LIMIT 1';
    const { rows } = await db.query(sql, params);
    return withId(rows[0] || null);
}

// History rows join users_projection for changed_by_*_name — the users table
// lives in the identity DB, so the monolith's LEFT JOIN users is replaced by
// the local projection (fed by the migration backfill).
export async function history(db: Queryable, applicationId: unknown): Promise<Row[]> {
    const { rows } = await db.query(
        `SELECT h.*, u.first_name AS changed_by_first_name, u.last_name AS changed_by_last_name
         FROM application_status_history h
         LEFT JOIN users_projection u ON u.id = h.changed_by
         WHERE h.application_id = $1
         ORDER BY h.changed_at ASC, h.id ASC`,
        [applicationId]
    );
    return rows;
}

export interface ApplicationCreateData {
    candidate_id: number;
    vacancy_id: number;
    status?: string;
    cover_letter?: string | null;
    applied_at?: Date | string;
    created_by?: number | null;
}

// Creates the application plus its initial status-history row. Pass a
// client to run inside a wider transaction.
export async function create(db: Queryable, data: ApplicationCreateData): Promise<Row> {
    const status = (data.status || 'pending').toLowerCase();
    if (!APPLICATION_STATUSES.has(status)) {
        const err = new Error(`Invalid application status: ${status}`) as Error & { status?: number };
        err.status = 400;
        throw err;
    }
    const { rows } = await db.query(
        `INSERT INTO applications (candidate_id, vacancy_id, status, cover_letter, applied_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
            data.candidate_id,
            data.vacancy_id,
            status,
            data.cover_letter ?? null,
            data.applied_at || new Date(),
            data.created_by || null
        ]
    );
    const application = rows[0];
    if (!application) throw new Error('application insert returned no row');
    await db.query(
        `INSERT INTO application_status_history
            (application_id, from_status, to_status, changed_by, note)
         VALUES ($1, NULL, $2, $3, 'Application created')`,
        [application.id, status, data.created_by || null]
    );
    return withId(application);
}

// Legacy-shaped row (candidate + application merged) for API responses.
export async function legacyRow(db: Queryable, applicationId: unknown): Promise<Row | null> {
    const { rows } = await db.query(`${LEGACY_SELECT} AND a.id = $1`, [applicationId]);
    return rows[0] ? toLegacyRow(rows[0]) : null;
}

// Status transition + history row. Self-transactional unless the caller
// passes its own `client` (to join a wider transaction).
export async function updateStatus(
    pool: Pool,
    applicationId: unknown,
    toStatus: string,
    {
        changedBy = null,
        note = null,
        client = null
    }: { changedBy?: number | null; note?: string | null; client?: Queryable | null } = {}
): Promise<Row | null> {
    if (client) {
        return updateStatusTx(client, applicationId, toStatus, changedBy, note);
    }
    return withTransaction(pool, (c) => updateStatusTx(c, applicationId, toStatus, changedBy, note));
}

async function updateStatusTx(
    client: Queryable,
    applicationId: unknown,
    toStatus: string,
    changedBy: number | null,
    note: string | null
): Promise<Row | null> {
    const to = String(toStatus).toLowerCase();
    if (!APPLICATION_STATUSES.has(to)) {
        const err = new Error(`Invalid application status: ${to}`) as Error & { status?: number };
        err.status = 400;
        throw err;
    }
    const { rows } = await client.query(
        'SELECT status FROM applications WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [applicationId]
    );
    if (!rows[0]) return null;
    const from = rows[0].status;

    await client.query('UPDATE applications SET status = $2, updated_at = now() WHERE id = $1', [applicationId, to]);
    await client.query(
        `INSERT INTO application_status_history
            (application_id, from_status, to_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [applicationId, from, to, changedBy, note]
    );
    return legacyRow(client, applicationId);
}

// Whitelisted field update. If `status` is among the fields, a history row
// is written too — every status change is recorded. Self-transactional
// unless the caller passes its own `client`.
export async function updateById(
    pool: Pool,
    applicationId: unknown,
    fields: Record<string, unknown>,
    { changedBy = null, client = null }: { changedBy?: number | null; client?: Queryable | null } = {}
): Promise<Row | null> {
    if (client) {
        return updateByIdTx(client, applicationId, fields, changedBy);
    }
    return withTransaction(pool, (c) => updateByIdTx(c, applicationId, fields, changedBy));
}

async function updateByIdTx(
    client: Queryable,
    applicationId: unknown,
    fields: Record<string, unknown>,
    changedBy: number | null
): Promise<Row | null> {
    const keys = Object.keys(fields);
    const rejected = keys.filter((k) => !UPDATABLE_FIELDS.has(k));
    if (rejected.length > 0) {
        const err = new Error(`Invalid application update fields: ${rejected.join(', ')}`) as Error & {
            status?: number;
        };
        err.status = 400;
        throw err;
    }
    if (keys.length === 0) {
        return findById(client, applicationId);
    }

    let previousStatus: string | null = null;
    if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
        const { rows } = await client.query(
            'SELECT status FROM applications WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
            [applicationId]
        );
        if (!rows[0]) return null;
        previousStatus = rows[0].status;
    }

    const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    const values = keys.map((key) => (key === 'ai_feedback_analysis' ? JSON.stringify(fields[key]) : fields[key]));
    const { rows } = await client.query(
        `UPDATE applications SET ${setClause}, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [applicationId, ...values]
    );
    if (!rows[0]) return null;

    const newStatus = rows[0].status;
    if (previousStatus !== null && newStatus !== previousStatus) {
        await client.query(
            `INSERT INTO application_status_history
                (application_id, from_status, to_status, changed_by)
             VALUES ($1, $2, $3, $4)`,
            [applicationId, previousStatus, newStatus, changedBy]
        );
    }
    return withId(rows[0]);
}
