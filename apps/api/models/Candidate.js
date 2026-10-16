const db = require('../db');
const Application = require('./Application');
const Skill = require('./Skill');
const outbox = require('../utils/outbox');

const CANDIDATE_COLUMNS = `id, first_name, last_name, email, phone, linkedin, experience,
    education, location, skills, resume, current_position, created_at, updated_at`;

// Whitelist of candidate-owned updatable fields — never interpolate
// request-controlled identifiers into SQL.
const UPDATABLE_FIELDS = new Set([
    'first_name',
    'last_name',
    'email',
    'phone',
    'linkedin',
    'experience',
    'education',
    'location',
    'skills',
    'resume',
    'current_position'
]);

function normalizeEmail(email) {
    return String(email || '')
        .trim()
        .toLowerCase();
}

const Candidate = {
    // One row per application (legacy shape): applied_for = vacancy id.
    // Delegates to Application — per-application fields live there now.
    async find(filters = {}, opts = {}) {
        return Application.find(filters, opts);
    },

    // One row per application; applied_for = { _id, title } (legacy wire shape).
    async findWithVacancyTitle(filters = {}, opts = {}) {
        return Application.findWithVacancyTitle(filters, opts);
    },

    // Candidate record only (no application context). For status/feedback use
    // Application.resolveForCandidate / legacyRow.
    async findById(id) {
        const { rows } = await db.query(
            `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return db.withId(rows[0] || null);
    },

    async findByEmail(email) {
        const { rows } = await db.query(
            `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE email = $1 AND deleted_at IS NULL`,
            [normalizeEmail(email)]
        );
        return db.withId(rows[0] || null);
    },

    // Creates (or reuses, on email conflict) the candidate, then creates the
    // application + initial status-history row + skills links — one tx.
    // Returns the legacy wire shape: candidate fields + status/applied_at +
    // applied_for populated as { _id, title }.
    async createWithVacancy(data, { createdBy = null } = {}) {
        return db.withTransaction(async (client) => {
            const email = normalizeEmail(data.email);
            const { rows } = await client.query(
                `INSERT INTO candidates (first_name, last_name, email, phone, linkedin, experience,
                    education, location, skills, resume, current_position)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
                    data.current_position || null
                ]
            );
            let candidate = rows[0];
            if (!candidate) {
                // Email already registered — reuse the existing candidate and
                // attach the new application (emails are unique post-migration).
                candidate = (
                    await client.query(`SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE email = $1`, [email])
                ).rows[0];
            } else if (data.skills) {
                await Skill.syncCandidateSkills(client, candidate.id, data.skills);
            }

            const application = await Application.create(
                {
                    candidate_id: candidate.id,
                    vacancy_id: data.applied_for,
                    status: 'pending',
                    applied_at: data.applied_at || new Date(),
                    created_by: createdBy
                },
                client
            );

            const vacancyTitle =
                (await client.query('SELECT title FROM vacancies WHERE id = $1', [data.applied_for])).rows[0]?.title ??
                null;

            // Transactional outbox — strafor.application.submitted (see
            // packages/contracts/events/application.js ApplicationSubmitted).
            // email/name/vacancyTitle are the recipient hints the
            // notifications consumer routes on.
            const submittedPayload = {
                candidateId: Number(candidate.id),
                vacancyId: Number(data.applied_for),
                email,
                appliedAt: new Date(application.applied_at).toISOString(),
                hasResume: Boolean(candidate.resume)
            };
            const fullName = `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`.trim();
            if (fullName) submittedPayload.name = fullName;
            if (vacancyTitle) submittedPayload.vacancyTitle = vacancyTitle;
            await outbox.record(client, {
                aggregateType: 'application',
                aggregateId: application.id,
                eventType: 'strafor.application.submitted',
                payload: submittedPayload
            });

            db.withId(candidate);
            return {
                ...candidate,
                application_id: application.id,
                status: application.status,
                applied_at: application.applied_at,
                applied_for: { _id: String(data.applied_for), title: vacancyTitle }
            };
        });
    },

    // Plain candidate insert (no application). Prefer createWithVacancy for
    // the POST /api/candidates flow.
    async create(data) {
        const { rows } = await db.query(
            `INSERT INTO candidates (first_name, last_name, email, phone, linkedin, experience,
                education, location, skills, resume, current_position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING ${CANDIDATE_COLUMNS}`,
            [
                data.first_name,
                data.last_name,
                normalizeEmail(data.email),
                data.phone,
                data.linkedin || null,
                data.experience,
                data.education,
                data.location,
                data.skills,
                data.resume || null,
                data.current_position || null
            ]
        );
        return db.withId(rows[0]);
    },

    async updateById(id, fields) {
        const keys = Object.keys(fields);
        const rejected = keys.filter((k) => !UPDATABLE_FIELDS.has(k));
        if (rejected.length > 0) {
            const err = new Error(`Invalid candidate update fields: ${rejected.join(', ')}`);
            err.status = 400;
            throw err;
        }
        if (keys.length === 0) {
            return this.findById(id);
        }
        return db.withTransaction(async (client) => {
            const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
            const values = keys.map((key) => (key === 'email' ? normalizeEmail(fields[key]) : fields[key]));
            const { rows } = await client.query(
                `UPDATE candidates SET ${setClause}, updated_at = now()
                 WHERE id = $1 AND deleted_at IS NULL RETURNING ${CANDIDATE_COLUMNS}`,
                [id, ...values]
            );
            const candidate = rows[0] || null;
            if (candidate && Object.prototype.hasOwnProperty.call(fields, 'skills')) {
                // Dual-write into candidate_skills (raw CSV stays the display value).
                await Skill.syncCandidateSkills(client, id, fields.skills);
            }
            return db.withId(candidate);
        });
    },

    // Soft delete — keeps applications (RESTRICT) intact for audit/history.
    async softDeleteById(id) {
        const { rows } = await db.query(
            'UPDATE candidates SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
            [id]
        );
        return rows[0] || null;
    },

    async count(where = '', params = []) {
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS count FROM candidates WHERE deleted_at IS NULL${where}`,
            params
        );
        return rows[0].count;
    }
};

module.exports = Candidate;
