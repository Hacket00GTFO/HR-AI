const db = require('../db');
const Skill = require('./Skill');
const outbox = require('../utils/outbox');

// Wire format kept stable: salary_range is synthesized from the structured
// salary_* columns, created_by is the creator's display name (was free text).
const SELECT = `
    SELECT v.*,
           (SELECT u.first_name || ' ' || u.last_name
            FROM users u WHERE u.id = v.created_by_user_id) AS created_by
    FROM vacancies v
`;

function toApi(row) {
    if (!row) return row;
    db.withId(row);
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

const Vacancy = {
    async find(filters = {}) {
        const where = ['v.deleted_at IS NULL'];
        const params = [];

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
        return rows.map(toApi);
    },

    async findById(id) {
        const { rows } = await db.query(`${SELECT} WHERE v.id = $1 AND v.deleted_at IS NULL`, [id]);
        return toApi(rows[0] || null);
    },

    async create(data) {
        const salaryRange = data.salary_range || {};
        return db.withTransaction(async (client) => {
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
            if (Array.isArray(data.skills_required) && data.skills_required.length > 0) {
                // Dual-write into vacancy_skills (raw text[] stays for the matcher).
                await Skill.syncVacancySkills(client, vacancy.id, data.skills_required);
            }
            // Transactional outbox — strafor.vacancy.published (see
            // packages/contracts/events/vacancy.js VacancyPublished).
            await outbox.record(client, {
                aggregateType: 'vacancy',
                aggregateId: vacancy.id,
                eventType: 'strafor.vacancy.published',
                payload: {
                    vacancyId: Number(vacancy.id),
                    title: vacancy.title,
                    department: vacancy.department,
                    location: vacancy.location,
                    type: vacancy.type,
                    ...(vacancy.experience_level ? { experienceLevel: vacancy.experience_level } : {}),
                    skillsRequired: Array.isArray(vacancy.skills_required) ? vacancy.skills_required : [],
                    ...(vacancy.created_by_user_id ? { publishedBy: Number(vacancy.created_by_user_id) } : {})
                }
            });
            return toApi(vacancy);
        });
    },

    // Soft delete (saga-lite): the vacancy and all its applications are
    // tombstoned in one transaction. FKs are RESTRICT — nothing is removed.
    async softDeleteById(id, { closedBy = null } = {}) {
        return db.withTransaction(async (client) => {
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
                // strafor.recruitment.vacancy_closed — no legacy
                // strafor.vacancy.closed contract exists, so the recruitment
                // twin is the canonical type for deletes.
                await outbox.record(client, {
                    aggregateType: 'vacancy',
                    aggregateId: vacancy.id,
                    eventType: 'strafor.recruitment.vacancy_closed',
                    payload: {
                        vacancyId: Number(vacancy.id),
                        reason: 'deleted',
                        ...(Number.isInteger(closedBy) ? { closedBy } : {})
                    }
                });
            }
            return toApi(vacancy);
        });
    },

    async count() {
        const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM vacancies WHERE deleted_at IS NULL');
        return rows[0].count;
    },

    async countByStatus(status) {
        const { rows } = await db.query(
            'SELECT COUNT(*)::int AS count FROM vacancies WHERE status = $1 AND deleted_at IS NULL',
            [status]
        );
        return rows[0].count;
    },

    // Single query replacing the N+1 loop in department-stats and generate-report.
    async departmentApplicationCounts() {
        const { rows } = await db.query(
            `SELECT v.department, COUNT(a.id)::int AS candidates
             FROM vacancies v
             LEFT JOIN applications a ON a.vacancy_id = v.id AND a.deleted_at IS NULL
             WHERE v.deleted_at IS NULL
             GROUP BY v.department`
        );
        return rows;
    }
};

module.exports = Vacancy;
