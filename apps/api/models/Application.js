const db = require('../db');
const outbox = require('../utils/outbox');

const APPLICATION_STATUSES = new Set(['pending', 'interview', 'accepted', 'rejected']);

// Minimal recipient-hint check: a malformed email must not roll back a
// legitimate status change — the event still flows, the notifications
// consumer just can't route it (same as before the outbox existed).
const EMAILISH = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Shared payload builder for strafor.candidate.status_changed (see
// packages/contracts/events/candidate.js CandidateStatusChanged). `contact`
// carries the denormalized candidate fields (email/first_name/last_name).
function statusChangedPayload({ applicationId, candidateId, vacancyId, from, to, changedBy, contact }) {
    const payload = {
        candidateId: Number(candidateId),
        newStatus: to
    };
    if (vacancyId != null) payload.vacancyId = Number(vacancyId);
    if (APPLICATION_STATUSES.has(from)) payload.previousStatus = from;
    if (Number.isInteger(changedBy) && changedBy > 0) payload.changedBy = changedBy;
    if (contact) {
        if (typeof contact.email === 'string' && EMAILISH.test(contact.email)) payload.email = contact.email;
        const name = `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim();
        if (name) payload.name = name;
    }
    return {
        aggregateType: 'application',
        aggregateId: applicationId,
        eventType: 'strafor.candidate.status_changed',
        payload
    };
}

// "Legacy candidate view": one row per application with the candidate fields
// merged in. This preserves the pre-split wire shape — status,
// hiring_feedback, ai_feedback_analysis, applied_at and applied_for used to
// live on candidates; they now come from applications.
const LEGACY_SELECT = `
    SELECT
        c.id, c.first_name, c.last_name, c.email, c.phone, c.linkedin,
        c.experience, c.education, c.location, c.skills, c.resume,
        c.current_position, c.created_at, c.updated_at,
        a.id AS application_id,
        a.vacancy_id AS applied_for,
        a.status, a.hiring_feedback, a.ai_insights, a.ai_feedback_analysis,
        a.feedback_timestamp, a.applied_at,
        v.title AS vacancy_title
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
    LEFT JOIN vacancies v ON v.id = a.vacancy_id
    WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL
`;

// ORDER BY whitelist — never interpolate request-controlled identifiers.
const SORTABLE = {
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

function safeOrderBy(orderBy, fallback = 'a.applied_at DESC') {
    const [col, dir] = String(orderBy || '')
        .trim()
        .split(/\s+/);
    const target = SORTABLE[col];
    if (!target) return fallback;
    return `${target} ${String(dir || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`;
}

function safeLimit(limit) {
    const n = Number(limit);
    return Number.isInteger(n) && n > 0 && n <= 1000 ? n : null;
}

function buildFiltered(filters = {}, { orderBy = 'applied_at DESC', limit = null } = {}) {
    const where = [];
    const params = [];

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

function toLegacyRow(row) {
    // Strip the join helper column; applied_for stays the vacancy id (int),
    // exactly like the old candidates.applied_for column.
    // eslint-disable-next-line no-unused-vars -- rest-destructure used to omit the column
    const { vacancy_title, ...rest } = row;
    return db.withId(rest);
}

function toLegacyRowWithVacancy(row) {
    const { vacancy_title, ...rest } = row;
    db.withId(rest);
    rest.applied_for = rest.applied_for != null ? { _id: String(rest.applied_for), title: vacancy_title } : null;
    return rest;
}

const Application = {
    STATUSES: APPLICATION_STATUSES,

    // One row per application, legacy candidate shape (applied_for = int).
    async find(filters = {}, opts = {}) {
        const { sql, params } = buildFiltered(filters, opts);
        const { rows } = await db.query(sql, params);
        return rows.map(toLegacyRow);
    },

    // Same, but applied_for is populated as { _id, title } — this is what
    // GET /api/candidates and the dashboard activity feed consume.
    async findWithVacancyTitle(filters = {}, opts = {}) {
        const { sql, params } = buildFiltered(filters, opts);
        const { rows } = await db.query(sql, params);
        return rows.map(toLegacyRowWithVacancy);
    },

    async findForVacancy(vacancyId, opts = {}) {
        return this.find({ applied_for: vacancyId }, opts);
    },

    // Canonical nested shape used by GET /api/vacancies/:id/applications.
    async findDetailedByVacancy(vacancyId) {
        const { rows } = await db.query(
            `SELECT a.id, a.status, a.hiring_feedback, a.ai_insights,
                    a.ai_feedback_analysis, a.feedback_timestamp, a.applied_at,
                    a.created_by, a.created_at, a.updated_at,
                    c.id AS candidate_id, c.first_name, c.last_name, c.email,
                    c.phone, c.linkedin, c.experience, c.education, c.location,
                    c.skills, c.resume, c.current_position
             FROM applications a
             JOIN candidates c ON c.id = a.candidate_id
             WHERE a.vacancy_id = $1 AND a.deleted_at IS NULL AND c.deleted_at IS NULL
             ORDER BY a.applied_at DESC`,
            [vacancyId]
        );
        return rows.map((row) => {
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
                current_position,
                ...app
            } = row;
            return {
                ...app,
                _id: String(app.id),
                vacancy_id: Number(vacancyId),
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
                    current_position
                }
            };
        });
    },

    async findById(id, client = db) {
        const { rows } = await client.query('SELECT * FROM applications WHERE id = $1 AND deleted_at IS NULL', [id]);
        return db.withId(rows[0] || null);
    },

    // Resolve which application a candidate-level write should hit: an explicit
    // vacancy when given, otherwise the most recent live application.
    async resolveForCandidate(candidateId, vacancyId, client = db) {
        const params = [candidateId];
        let sql = `SELECT * FROM applications
                   WHERE candidate_id = $1 AND deleted_at IS NULL`;
        if (vacancyId !== undefined && vacancyId !== null) {
            params.push(vacancyId);
            sql += ` AND vacancy_id = $${params.length}`;
        }
        sql += ' ORDER BY applied_at DESC, id DESC LIMIT 1';
        const { rows } = await client.query(sql, params);
        return db.withId(rows[0] || null);
    },

    async history(applicationId, client = db) {
        const { rows } = await client.query(
            `SELECT h.*, u.first_name AS changed_by_first_name, u.last_name AS changed_by_last_name
             FROM application_status_history h
             LEFT JOIN users u ON u.id = h.changed_by
             WHERE h.application_id = $1
             ORDER BY h.changed_at ASC, h.id ASC`,
            [applicationId]
        );
        return rows;
    },

    // Creates the application plus its initial status-history row. Pass a
    // client to run inside a wider transaction.
    async create(data, client = db) {
        const status = (data.status || 'pending').toLowerCase();
        if (!APPLICATION_STATUSES.has(status)) {
            const err = new Error(`Invalid application status: ${status}`);
            err.status = 400;
            throw err;
        }
        const { rows } = await client.query(
            `INSERT INTO applications (candidate_id, vacancy_id, status, applied_at, created_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [data.candidate_id, data.vacancy_id, status, data.applied_at || new Date(), data.created_by || null]
        );
        const application = rows[0];
        await client.query(
            `INSERT INTO application_status_history
                (application_id, from_status, to_status, changed_by, note)
             VALUES ($1, NULL, $2, $3, 'Application created')`,
            [application.id, status, data.created_by || null]
        );
        return db.withId(application);
    },

    // Legacy-shaped row (candidate + application merged) for API responses.
    async legacyRow(applicationId, client = db) {
        const { rows } = await client.query(`${LEGACY_SELECT} AND a.id = $1`, [applicationId]);
        return rows[0] ? toLegacyRow(rows[0]) : null;
    },

    // Status transition + history row. Self-transactional unless the caller
    // passes its own `client` (to join a wider transaction).
    async updateStatus(applicationId, toStatus, { changedBy = null, note = null, client } = {}) {
        if (client) {
            return this._updateStatusTx(applicationId, toStatus, changedBy, note, client);
        }
        return db.withTransaction((c) => this._updateStatusTx(applicationId, toStatus, changedBy, note, c));
    },

    async _updateStatusTx(applicationId, toStatus, changedBy, note, client) {
        const to = String(toStatus).toLowerCase();
        if (!APPLICATION_STATUSES.has(to)) {
            const err = new Error(`Invalid application status: ${to}`);
            err.status = 400;
            throw err;
        }
        const { rows } = await client.query(
            'SELECT status FROM applications WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
            [applicationId]
        );
        if (!rows[0]) return null;
        const from = rows[0].status;

        await client.query('UPDATE applications SET status = $2, updated_at = now() WHERE id = $1', [
            applicationId,
            to
        ]);
        await client.query(
            `INSERT INTO application_status_history
                (application_id, from_status, to_status, changed_by, note)
             VALUES ($1, $2, $3, $4, $5)`,
            [applicationId, from, to, changedBy, note]
        );
        const row = await this.legacyRow(applicationId, client);
        if (row) {
            // Transactional outbox — strafor.candidate.status_changed.
            // legacyRow carries the candidate's contact fields (email,
            // first_name, last_name) for the notifications consumer.
            await outbox.record(
                client,
                statusChangedPayload({
                    applicationId,
                    candidateId: row.id,
                    vacancyId: row.applied_for,
                    from,
                    to,
                    changedBy,
                    contact: row
                })
            );
        }
        return row;
    },

    // Whitelisted field update. If `status` is among the fields, a history row
    // is written too — every status change is recorded. Self-transactional
    // unless the caller passes its own `client`.
    async updateById(applicationId, fields, { changedBy = null, client } = {}) {
        if (client) {
            return this._updateByIdTx(applicationId, fields, changedBy, client);
        }
        return db.withTransaction((c) => this._updateByIdTx(applicationId, fields, changedBy, c));
    },

    async _updateByIdTx(applicationId, fields, changedBy, client) {
        const keys = Object.keys(fields);
        const rejected = keys.filter((k) => !UPDATABLE_FIELDS.has(k));
        if (rejected.length > 0) {
            const err = new Error(`Invalid application update fields: ${rejected.join(', ')}`);
            err.status = 400;
            throw err;
        }
        if (keys.length === 0) {
            return this.findById(applicationId, client);
        }

        let previousStatus = null;
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
            // Every status transition emits the domain event — not only the
            // ones going through updateStatus().
            const contact = (
                await client.query('SELECT id, email, first_name, last_name FROM candidates WHERE id = $1', [
                    rows[0].candidate_id
                ])
            ).rows[0];
            await outbox.record(
                client,
                statusChangedPayload({
                    applicationId,
                    candidateId: rows[0].candidate_id,
                    vacancyId: rows[0].vacancy_id,
                    from: previousStatus,
                    to: newStatus,
                    changedBy,
                    contact
                })
            );
        }
        return db.withId(rows[0]);
    },

    async softDeleteForVacancy(vacancyId, client = db) {
        const { rowCount } = await client.query(
            `UPDATE applications SET deleted_at = now()
             WHERE vacancy_id = $1 AND deleted_at IS NULL`,
            [vacancyId]
        );
        return rowCount;
    },

    async countByStatus(status) {
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS count FROM applications
             WHERE status = $1 AND deleted_at IS NULL`,
            [status]
        );
        return rows[0].count;
    },

    async count() {
        const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM applications WHERE deleted_at IS NULL');
        return rows[0].count;
    }
};

module.exports = Application;
