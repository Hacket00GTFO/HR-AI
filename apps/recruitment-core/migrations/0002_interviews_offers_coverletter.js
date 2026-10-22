/**
 * 0002_interviews_offers_coverletter — feature-gap closure for
 * recruitment-core (DB: strafor_recruitment).
 *
 *   applications.cover_letter      — free-text letter sent by the candidate
 *                                    portal on POST /v1/public/apply. HR-only
 *                                    field: never returned by public
 *                                    endpoints, never placed in event payloads.
 *   vacancies_status_check         — canonical lifecycle unified to
 *                                    {Draft, Active, Paused, Closed, Archived}.
 *                                    0001 created the CHECK without 'Paused'
 *                                    while the API schema already accepted it
 *                                    (a PUT status:'Paused' died on the
 *                                    constraint); 'Archived' existed in the DB
 *                                    but was rejected by the API. Both sides
 *                                    now agree.
 *   interviews                     — interview scheduling per application:
 *                                    scheduled_at, duration, interviewer
 *                                    (identity user id — no cross-DB FK),
 *                                    location/link, lifecycle
 *                                    {scheduled, done, cancelled} and a
 *                                    scorecard JSONB (criteria ratings 1-5 +
 *                                    notes).
 *   offers                         — salary/start-date/terms offers attached
 *                                    to an application; lifecycle
 *                                    draft → sent → accepted|declined|expired.
 *                                    At most one live (draft|sent) offer per
 *                                    application (partial unique index).
 */
exports.up = (pgm) => {
    pgm.sql(`
        ALTER TABLE applications ADD COLUMN cover_letter TEXT;

        COMMENT ON COLUMN applications.cover_letter IS
            'Candidate-written cover letter submitted via POST /v1/public/apply. '
            'HR-only data — never exposed on public endpoints or domain events.';

        -- Canonical vacancy lifecycle: Draft|Active|Paused|Closed|Archived.
        ALTER TABLE vacancies DROP CONSTRAINT vacancies_status_check;
        ALTER TABLE vacancies ADD CONSTRAINT vacancies_status_check
            CHECK (status IN ('Draft', 'Active', 'Paused', 'Closed', 'Archived'));

        CREATE TABLE interviews (
            id SERIAL PRIMARY KEY,
            application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
            candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
            vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE RESTRICT,
            scheduled_at TIMESTAMPTZ NOT NULL,
            duration_minutes INTEGER NOT NULL DEFAULT 60
                CONSTRAINT interviews_duration_check
                CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
            interviewer_user_id INTEGER,
            location_or_link VARCHAR(500),
            status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                CONSTRAINT interviews_status_check
                CHECK (status IN ('scheduled', 'done', 'cancelled')),
            scorecard JSONB,
            notes TEXT,
            created_by INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        COMMENT ON COLUMN interviews.interviewer_user_id IS
            'References users(id) owned by identity-auth (strafor_identity DB). '
            'No FK — display names come from users_projection.';
        COMMENT ON COLUMN interviews.scorecard IS
            'Structured evaluation: { criteria: [{name, rating 1-5, notes}], '
            'overall_rating 1-5, notes }. Filled when status -> done.';

        CREATE INDEX idx_interviews_vacancy_id ON interviews(vacancy_id);
        CREATE INDEX idx_interviews_application_id ON interviews(application_id);
        CREATE INDEX idx_interviews_candidate_id ON interviews(candidate_id);
        CREATE INDEX idx_interviews_scheduled_at ON interviews(scheduled_at);

        CREATE TABLE offers (
            id SERIAL PRIMARY KEY,
            application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
            salary NUMERIC(12,2) NOT NULL
                CONSTRAINT offers_salary_check CHECK (salary >= 0),
            salary_currency VARCHAR(10),
            start_date DATE,
            terms TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'sent'
                CONSTRAINT offers_status_check
                CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
            decision_reason TEXT,
            sent_at TIMESTAMPTZ,
            decided_at TIMESTAMPTZ,
            created_by INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        COMMENT ON COLUMN offers.created_by IS
            'References users(id) owned by identity-auth (strafor_identity DB). '
            'No FK — referential integrity is application-level.';

        -- At most one live (draft|sent) offer per application.
        CREATE UNIQUE INDEX offers_application_live_uidx
            ON offers (application_id) WHERE status IN ('draft', 'sent');

        CREATE INDEX idx_offers_application_id ON offers(application_id);
        CREATE INDEX idx_offers_status ON offers(status);
    `);

    for (const table of ['interviews', 'offers']) {
        pgm.sql(`
            CREATE TRIGGER trg_${table}_updated_at
            BEFORE UPDATE ON ${table}
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        `);
    }
};

exports.down = (pgm) => {
    for (const table of ['interviews', 'offers']) {
        pgm.sql(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`);
    }
    pgm.sql(`
        DROP TABLE offers;
        DROP TABLE interviews;

        ALTER TABLE vacancies DROP CONSTRAINT vacancies_status_check;
        ALTER TABLE vacancies ADD CONSTRAINT vacancies_status_check
            CHECK (status IN ('Active', 'Closed', 'Draft', 'Archived'));

        ALTER TABLE applications DROP COLUMN cover_letter;
    `);
};
