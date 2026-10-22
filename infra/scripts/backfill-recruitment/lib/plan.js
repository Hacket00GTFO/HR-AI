/**
 * Table plan for the recruitment-core backfill (innovation → strafor_recruitment).
 *
 * Copy order is FK-safe for the target schema (no deferrable constraints):
 * parents first, join/child tables after.
 *
 * Per-table fields:
 *   name        — target table
 *   source      — source table in the monolith DB (defaults to `name`)
 *   columns     — column list copied verbatim (same names both sides)
 *   pk          — primary-key column list (keyset pagination + ON CONFLICT target)
 *   sequence    — serial sequence to setval after copy (null → none)
 *   optional    — skip with a warning when the source table is absent
 *   verifyColumns — columns included in the verify checksum (defaults to
 *                 `columns`; used to exclude service-managed values like
 *                 users_projection.updated_at)
 *   textCast    — columns selected as `col::text` on the source. The pg driver
 *                 maps timestamptz to JS Date (millisecond precision), which
 *                 would silently truncate microseconds; reading them as text
 *                 round-trips the full precision through the INSERT params.
 *
 * Column-level divergences between `innovation` and `strafor_recruitment`
 * (verified against live schemas + migrations 0001–0010 / 0001_recruitment):
 *   - candidates.resume_document_id UUID  — target-only; left NULL (the legacy
 *     `resume` filename column IS copied for the RESUMES_DIR fallback).
 *   - users_projection — target-only; sourced from monolith `users`
 *     (id, first_name, last_name, email). `updated_at` is service-managed.
 *   - outbox_events — target-only; intentionally NOT backfilled (transactional
 *     outbox starts empty; legacy events were already published).
 * Everything else is a 1:1 column copy preserving source primary keys.
 */
const TABLES = [
    {
        name: 'skills',
        columns: ['id', 'name', 'esco_uri', 'created_at'],
        pk: ['id'],
        sequence: 'skills_id_seq',
        textCast: ['created_at']
    },
    {
        name: 'vacancies',
        columns: [
            'id',
            'title',
            'company',
            'location',
            'type',
            'description',
            'requirements',
            'responsibilities',
            'skills_required',
            'experience_level',
            'salary_min',
            'salary_max',
            'salary_currency',
            'benefits',
            'application_deadline',
            'remote_option',
            'status',
            'external_postings',
            'created_by_user_id',
            'department',
            'created_at',
            'updated_at',
            'deleted_at'
        ],
        pk: ['id'],
        sequence: 'vacancies_id_seq',
        textCast: ['application_deadline', 'created_at', 'updated_at', 'deleted_at']
    },
    {
        name: 'candidates',
        columns: [
            'id',
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
            'current_position',
            'created_at',
            'updated_at',
            'deleted_at'
        ],
        pk: ['id'],
        sequence: 'candidates_id_seq',
        textCast: ['created_at', 'updated_at', 'deleted_at']
    },
    {
        name: 'candidate_skills',
        columns: ['candidate_id', 'skill_id', 'created_at'],
        pk: ['candidate_id', 'skill_id'],
        sequence: null,
        textCast: ['created_at']
    },
    {
        name: 'vacancy_skills',
        columns: ['vacancy_id', 'skill_id', 'required', 'created_at'],
        pk: ['vacancy_id', 'skill_id'],
        sequence: null,
        textCast: ['created_at']
    },
    {
        name: 'applications',
        columns: [
            'id',
            'candidate_id',
            'vacancy_id',
            'status',
            'hiring_feedback',
            'ai_insights',
            'ai_feedback_analysis',
            'feedback_timestamp',
            'applied_at',
            'created_by',
            'created_at',
            'updated_at',
            'deleted_at'
        ],
        pk: ['id'],
        sequence: 'applications_id_seq',
        textCast: ['feedback_timestamp', 'applied_at', 'created_at', 'updated_at', 'deleted_at']
    },
    {
        name: 'application_status_history',
        columns: ['id', 'application_id', 'from_status', 'to_status', 'changed_by', 'changed_at', 'note'],
        pk: ['id'],
        sequence: 'application_status_history_id_seq',
        textCast: ['changed_at']
    },
    {
        // Target-only table: display-name projection of the monolith/identity
        // `users` table. `updated_at` is set by the service default (now()) and
        // is excluded from the verify checksum.
        name: 'users_projection',
        source: 'users',
        columns: ['id', 'first_name', 'last_name', 'email'],
        pk: ['id'],
        sequence: null,
        optional: true,
        verifyColumns: ['id', 'first_name', 'last_name', 'email']
    }
];

/** Target-owned tables that must never be written by the backfill. */
const TARGET_ONLY = ['outbox_events'];

const byName = new Map(TABLES.map((t) => [t.name, t]));

const sourceTable = (spec) => spec.source || spec.name;
const verifyColumns = (spec) => spec.verifyColumns || spec.columns;

module.exports = { TABLES, TARGET_ONLY, byName, sourceTable, verifyColumns };
