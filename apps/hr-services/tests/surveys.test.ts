// NOM-035 / climate survey tests: respondent pseudonymisation (HMAC, raw
// employee_id never persisted), duplicate-response 409s, health-answer
// isolation + audit trail, and k-anonymity on aggregates (n<5 suppressed).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { EMP_A, EMPLOYEE_ID_A, HR, testApp, testConfig } from './helpers.js';
import { applyKAnonymity, respondentHash } from '../src/routes/surveys.js';

const SURVEY = {
    id: 1,
    title: 'NOM-035 2025',
    type: 'nom035',
    status: 'open',
    opens_at: '2025-01-01T00:00:00Z',
    closes_at: null,
    created_by: 2,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
};

const QUESTIONS = [
    { id: 1, scale: 5, health_related: false },
    { id: 2, scale: 5, health_related: false },
    { id: 3, scale: 5, health_related: true } // psicosocial / medical risk factor
];

function respondHandler(overrides: { surveyStatus?: string; failOnInsert?: boolean } = {}) {
    return (text: string) => {
        if (text.includes('SELECT * FROM surveys')) {
            return { rows: [{ ...SURVEY, status: overrides.surveyStatus ?? 'open' }] };
        }
        if (text.includes('FROM survey_questions')) return { rows: QUESTIONS };
        if (text.includes('INSERT INTO survey_responses')) {
            if (overrides.failOnInsert) {
                const err = new Error('duplicate key') as Error & { code: string };
                err.code = '23505';
                throw err;
            }
            return { rows: [{ id: 44, submitted_at: '2025-02-01T00:00:00Z' }] };
        }
        return { rows: [] };
    };
}

describe('respondent pseudonymisation', () => {
    it('stores an HMAC hash — never the raw employee_id', async () => {
        const { app, stub } = testApp(respondHandler());
        const res = await request(app)
            .post('/v1/surveys/1/respond')
            .set(EMP_A)
            .send({ answers: { '1': 4, '2': 3, '3': 2 } });
        expect(res.status).toBe(201);
        const insert = stub.calls.find((c) => c.text.includes('INSERT INTO survey_responses'))!;
        const hash = insert.params[1] as string;
        expect(hash).toBe(respondentHash(testConfig(), 1, EMPLOYEE_ID_A));
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        // No parameter carries the raw employee id.
        for (const p of insert.params) {
            expect(String(p)).not.toBe(String(EMPLOYEE_ID_A));
        }
    });

    it('different employees produce different hashes for the same survey', () => {
        const config = testConfig();
        expect(respondentHash(config, 1, 100)).not.toBe(respondentHash(config, 1, 200));
        expect(respondentHash(config, 1, 100)).not.toBe(respondentHash(config, 2, 100));
    });
});

describe('response submission rules', () => {
    it('duplicate response → 409 (unique respondent_hash per survey)', async () => {
        const { app } = testApp(respondHandler({ failOnInsert: true }));
        const res = await request(app)
            .post('/v1/surveys/1/respond')
            .set(EMP_A)
            .send({ answers: { '1': 4 } });
        expect(res.status).toBe(409);
    });

    it('responding to a closed survey is a 409', async () => {
        const { app } = testApp(respondHandler({ surveyStatus: 'closed' }));
        const res = await request(app)
            .post('/v1/surveys/1/respond')
            .set(EMP_A)
            .send({ answers: { '1': 4 } });
        expect(res.status).toBe(409);
    });

    it('answers to unknown question ids are rejected', async () => {
        const { app } = testApp(respondHandler());
        const res = await request(app)
            .post('/v1/surveys/1/respond')
            .set(EMP_A)
            .send({ answers: { '999': 4 } });
        expect(res.status).toBe(400);
    });

    it('health-related answers are split into survey_health_answers with an audit write', async () => {
        const { app, stub } = testApp(respondHandler());
        const res = await request(app)
            .post('/v1/surveys/1/respond')
            .set(EMP_A)
            .send({ answers: { '1': 4, '3': 2 } });
        expect(res.status).toBe(201);
        const healthInsert = stub.calls.find((c) => c.text.includes('INSERT INTO survey_health_answers'))!;
        expect(healthInsert.params[1]).toBe(JSON.stringify({ '3': 2 }));
        const audit = stub.calls.find((c) => c.text.includes('INSERT INTO survey_health_audit'))!;
        expect(audit.params).toEqual([44, 'write', 'employee:10']);
        // The public answers column must NOT contain the health answer.
        const respInsert = stub.calls.find((c) => c.text.includes('INSERT INTO survey_responses'))!;
        expect(respInsert.params[3]).toBe(JSON.stringify({ '1': 4 }));
    });
});

describe('k-anonymity (min group size 5)', () => {
    it('applyKAnonymity suppresses cells under the threshold', () => {
        const out = applyKAnonymity(
            [
                { grp: 'Engineering', dimension: 'liderazgo', respondents: 7, avg_score: 3.4 },
                { grp: 'Sales', dimension: 'liderazgo', respondents: 3, avg_score: 4.9 }
            ],
            5
        );
        expect(out[0]).toEqual({ group: 'Engineering', dimension: 'liderazgo', respondents: 7, avgScore: 3.4 });
        expect(out[1]).toEqual({ group: 'Sales', dimension: 'liderazgo', suppressed: true, reason: 'k<5' });
    });

    it('GET /results on an open survey suppresses n<5 groups and returns n>=5 aggregates', async () => {
        const { app } = testApp((text) => {
            if (text.includes('SELECT * FROM surveys')) return { rows: [SURVEY] };
            if (text.includes('FROM survey_responses WHERE survey_id')) return { rows: [{ n: 10 }] };
            if (text.includes('GROUP BY grp, dimension')) {
                return {
                    rows: [
                        { grp: 'Engineering', dimension: 'liderazgo', respondents: 7, avg_score: '3.400' },
                        { grp: 'Sales', dimension: 'liderazgo', respondents: 3, avg_score: '4.900' }
                    ]
                };
            }
            return { rows: [] };
        });
        const res = await request(app).get('/v1/surveys/1/results').set(HR);
        expect(res.status).toBe(200);
        expect(res.body.minGroupSize).toBe(5);
        expect(res.body.results).toContainEqual({
            group: 'Engineering',
            dimension: 'liderazgo',
            respondents: 7,
            avgScore: 3.4
        });
        expect(res.body.results).toContainEqual({
            group: 'Sales',
            dimension: 'liderazgo',
            suppressed: true,
            reason: 'k<5'
        });
        // No respondent hash or individual answer anywhere in the payload.
        expect(JSON.stringify(res.body)).not.toContain('respondent_hash');
        expect(JSON.stringify(res.body)).not.toContain('answers');
    });

    it('GET /results on a closed survey reads stored suppressed rows', async () => {
        const { app } = testApp((text) => {
            if (text.includes('SELECT * FROM surveys')) return { rows: [{ ...SURVEY, status: 'closed' }] };
            if (text.includes('FROM survey_responses WHERE survey_id')) return { rows: [{ n: 4 }] };
            if (text.includes('FROM survey_results_agg')) {
                return {
                    rows: [
                        {
                            grp: 'Engineering',
                            dimension: 'actividad',
                            respondents: 4,
                            avg_score: null,
                            suppressed: true
                        }
                    ]
                };
            }
            return { rows: [] };
        });
        const res = await request(app).get('/v1/surveys/1/results').set(HR);
        expect(res.status).toBe(200);
        expect(res.body.results).toEqual([
            { group: 'Engineering', dimension: 'actividad', suppressed: true, reason: 'k<5' }
        ]);
    });
});

describe('survey lifecycle', () => {
    it('open publishes strafor.services.survey_opened', async () => {
        const { app, publisher } = testApp((text) => {
            if (text.includes('SELECT * FROM surveys')) return { rows: [{ ...SURVEY, status: 'draft' }] };
            if (text.includes('UPDATE surveys')) return { rows: [{ ...SURVEY, status: 'open' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/surveys/1/open').set(HR);
        expect(res.status).toBe(200);
        expect(publisher.published.map((e) => e.type)).toContain('strafor.services.survey_opened');
    });

    it('close persists k-anonymised aggregates and publishes survey_closed', async () => {
        const { app, publisher, stub } = testApp((text) => {
            if (text.includes('SELECT * FROM surveys')) return { rows: [SURVEY] };
            if (text.includes('GROUP BY grp, dimension')) {
                return { rows: [{ grp: 'Engineering', dimension: 'liderazgo', respondents: 7, avg_score: '3.4' }] };
            }
            if (text.includes('FROM survey_responses WHERE survey_id')) return { rows: [{ n: 7 }] };
            if (text.includes('UPDATE surveys')) return { rows: [{ ...SURVEY, status: 'closed' }] };
            return { rows: [] };
        });
        const res = await request(app).post('/v1/surveys/1/close').set(HR);
        expect(res.status).toBe(200);
        const agg = stub.calls.find((c) => c.text.includes('INSERT INTO survey_results_agg'))!;
        expect(agg.params).toEqual([1, 'Engineering', 'liderazgo', 7, 3.4, false]);
        expect(publisher.published.map((e) => e.type)).toContain('strafor.services.survey_closed');
    });

    it('there is no route that lists individual responses (HR gets 404)', async () => {
        const { app } = testApp();
        const res = await request(app).get('/v1/surveys/1/responses').set(HR);
        expect(res.status).toBe(404);
    });
});
