import { withId, type Queryable } from '../db.js';
import * as Skill from './skill.js';

// Wire format kept stable: salary_range is synthesized from the structured
// salary_* columns, created_by is the creator's display name resolved through
// users_projection (the users table lives in the identity DB — no cross-DB
// reads, no FK).
const SELECT = `
    SELECT v.*,
           (SELECT u.first_name || ' ' || u.last_name
            FROM users_projection u WHERE u.id = v.created_by_user_id) AS created_by
    FROM vacancies v
`;

export interface VacancyFilters {
    department?: string | undefined;
    location?: string | undefined;
    type?: string | undefined;
    salaryMin?: unknown;
    salaryMax?: unknown;
    skills?: string | string[] | undefined;
    search?: string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// Canonical lifecycle states — the same set the vacancies_status_check
// constraint enforces (migration 0002) and schemas.vacancyStatus accepts.
const CANONICAL_STATUS: Record<string, string> = {
    draft: 'Draft',
    active: 'Active',
    paused: 'Paused',
    closed: 'Closed',
    archived: 'Archived'
};

// Normalize on read: legacy rows may carry a lowercase/variant spelling.
export function normalizeStatus(status: unknown): unknown {
    return CANONICAL_STATUS[String(status ?? '').toLowerCase()] ?? status;
}

function toApi(row: Row | null): Row | null {
    if (!row) return row;
    withId(row);
    row.status = normalizeStatus(row.status);
    row.salary_range =
        row.salary_min != null || row.salary_max != null
            ? {
                  min: row.salary_min != null ? Number(row.salary_min) : null,
                  max: row.salary_max != null ? Number(row.salary_max) : null,
                  currency: row.salary_currency
              }
            : null;
    return row;
}

export async function find(db: Queryable, filters: VacancyFilters = {}): Promise<Row[]> {
    const where = ['v.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (filters.department) {
        params.push(filters.department);
        where.push(`v.department = $${params.length}`);
    }
    if (filters.location) {
        params.push(filters.location);
        where.push(`v.location = $${params.length}`);
    }
    if (filters.type) {
        params.push(filters.type);
        where.push(`v.type = $${params.length}`);
    }
    if (filters.salaryMin) {
        params.push(Number(filters.salaryMin));
        where.push(`v.salary_min >= $${params.length}`);
    }
    if (filters.salaryMax) {
        params.push(Number(filters.salaryMax));
        where.push(`v.salary_max <= $${params.length}`);
    }
    if (filters.skills) {
        const skillsArr = Array.isArray(filters.skills) ? filters.skills : filters.skills.split(',');
        params.push(skillsArr);
        where.push(`v.skills_required @> $${params.length}`);
    }
    if (filters.search) {
        params.push(`%${filters.search}%`);
        where.push(
            `(v.title ILIKE $${params.length} OR v.department ILIKE $${params.length} OR v.location ILIKE $${params.length} OR v.description ILIKE $${params.length})`
        );
    }

    const sql = `${SELECT} WHERE ${where.join(' AND ')} ORDER BY v.created_at DESC`;
    const { rows } = await db.query(sql, params);
    return rows.map(toApi) as Row[];
}

export async function findById(db: Queryable, id: unknown): Promise<Row | null> {
    const { rows } = await db.query(`${SELECT} WHERE v.id = $1 AND v.deleted_at IS NULL`, [id]);
    return toApi(rows[0] || null);
}

// Public careers listing (GET /v1/public/jobs) — open vacancies only, with a
// deliberately reduced public-safe shape: no salary columns, no
// external_postings, no created_by, no internal timestamps. `type` is
// relabeled employment_type and created_at is surfaced as published_at.
export async function findOpen(db: Queryable): Promise<Row[]> {
    const { rows } = await db.query(
        `SELECT v.id, v.title, v.company, v.department, v.location,
                v.type AS employment_type, v.description, v.requirements,
                v.responsibilities, v.skills_required, v.experience_level,
                v.benefits, v.remote_option, v.application_deadline,
                v.created_at AS published_at
         FROM vacancies v
         WHERE v.status = 'Active' AND v.deleted_at IS NULL
         ORDER BY v.created_at DESC`
    );
    return rows.map((r) => withId(r));
}

export interface VacancyCreateData {
    title: string;
    company: string;
    location: string;
    type: string;
    description: string;
    requirements: string;
    responsibilities: string;
    skills_required?: string[];
    experience_level: string;
    salary_range?: { min?: unknown; max?: unknown; currency?: string } | null;
    benefits?: string[];
    application_deadline?: Date | null;
    remote_option?: boolean;
    status?: string;
    external_postings?: unknown;
    created_by_user_id?: number | null;
    department: string;
}

export async function create(client: Queryable, data: VacancyCreateData): Promise<Row> {
    const salaryRange = data.salary_range || {};
    const { rows } = await client.query(
        `INSERT INTO vacancies (title, company, location, type, description, requirements,
            responsibilities, skills_required, experience_level, salary_min, salary_max,
            salary_currency, benefits, application_deadline, remote_option, status,
            external_postings, created_by_user_id, department)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [
            data.title,
            data.company,
            data.location,
            data.type,
            data.description,
            data.requirements,
            data.responsibilities,
            data.skills_required,
            data.experience_level,
            salaryRange.min != null ? Number(salaryRange.min) : null,
            salaryRange.max != null ? Number(salaryRange.max) : null,
            salaryRange.currency || null,
            data.benefits,
            data.application_deadline,
            data.remote_option,
            data.status,
            JSON.stringify(data.external_postings),
            data.created_by_user_id ?? null,
            data.department
        ]
    );
    const vacancy = rows[0];
    if (!vacancy) throw new Error('vacancy insert returned no row');
    if (Array.isArray(data.skills_required) && data.skills_required.length > 0) {
        // Dual-write into vacancy_skills (raw text[] stays for the matcher).
        await Skill.syncVacancySkills(client, vacancy.id, data.skills_required);
    }
    return toApi(vacancy) as Row;
}

// Soft delete (saga-lite): the vacancy and all its applications are
// tombstoned in one transaction (the caller owns it). FKs are RESTRICT —
// nothing is removed.
export async function softDeleteById(client: Queryable, id: unknown): Promise<Row | null> {
    const { rows } = await client.query(
        `UPDATE vacancies SET deleted_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [id]
    );
    const vacancy = rows[0] || null;
    if (vacancy) {
        await client.query(
            `UPDATE applications SET deleted_at = now()
             WHERE vacancy_id = $1 AND deleted_at IS NULL`,
            [id]
        );
    }
    return toApi(vacancy);
}
