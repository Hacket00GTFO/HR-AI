// Schema tests — ported from apps/api/tests/vacancies.update.test.js and
// public.apply.test.js. The wire contract must not drift from the monolith.
import { describe, it, expect } from 'vitest';
import * as schemas from '../src/schemas.js';

describe('vacancyUpdateBody schema', () => {
    const partial = { title: 'Senior Backend Engineer', status: 'Paused' };

    it('accepts a partial update (title + status only)', () => {
        const r = schemas.vacancyUpdateBody.safeParse(partial);
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.title).toBe('Senior Backend Engineer');
            expect(r.data.status).toBe('Paused');
        }
    });

    it('rejects an empty body and a body of only unknown keys', () => {
        expect(schemas.vacancyUpdateBody.safeParse({}).success).toBe(false);
        expect(schemas.vacancyUpdateBody.safeParse({ hacker: 'stuff' }).success).toBe(false);
    });

    it('rejects an invalid lifecycle status', () => {
        expect(schemas.vacancyUpdateBody.safeParse({ status: 'exploding' }).success).toBe(false);
        expect(schemas.vacancyUpdateBody.safeParse({ status: 'Active' }).success).toBe(true);
    });

    it('trims skills and requires a non-empty skills_required when provided', () => {
        const ok = schemas.vacancyUpdateBody.safeParse({ skills_required: [' react ', '', 'node'] });
        expect(ok.success).toBe(true);
        if (ok.success) expect(ok.data.skills_required).toEqual(['react', 'node']);
        expect(schemas.vacancyUpdateBody.safeParse({ skills_required: [] }).success).toBe(false);
        expect(schemas.vacancyUpdateBody.safeParse({ skills_required: ['  '] }).success).toBe(false);
    });

    it('accepts salary_range + remote_option partials', () => {
        const r = schemas.vacancyUpdateBody.safeParse({
            salary_range: { min: '100', max: '200', currency: 'MXN' },
            remote_option: true
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.salary_range?.min).toBe(100);
    });
});

describe('candidateListQuery schema', () => {
    it('coerces vacancy_id, lowercases status, passes q through', () => {
        const r = schemas.candidateListQuery.safeParse({ status: 'Interview', vacancy_id: '7', q: 'react' });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.status).toBe('interview');
            expect(r.data.vacancy_id).toBe(7);
            expect(r.data.q).toBe('react');
        }
    });

    it('rejects a non-canonical status and a non-numeric vacancy_id', () => {
        expect(schemas.candidateListQuery.safeParse({ status: 'hired!' }).success).toBe(false);
        expect(schemas.candidateListQuery.safeParse({ vacancy_id: 'abc' }).success).toBe(false);
    });
});

describe('candidateStatusBody schema', () => {
    it('lowercases the status and accepts vacancy disambiguators', () => {
        const r = schemas.candidateStatusBody.safeParse({ status: 'Accepted', vacancy_id: '9' });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.status).toBe('accepted');
            expect(r.data.vacancy_id).toBe(9);
        }
    });

    it('rejects unknown keys and invalid status', () => {
        expect(schemas.candidateStatusBody.safeParse({ status: 'hired' }).success).toBe(false);
        expect(schemas.candidateStatusBody.safeParse({ status: 'accepted', hack: 1 }).success).toBe(false);
    });
});

describe('publicApplyBody schema', () => {
    const valid = {
        first_name: 'Ana',
        last_name: 'Garcia',
        email: 'Ana.Garcia@Example.com',
        phone: '+52 55 1234 5678',
        experience: '5',
        education: 'Bachelor',
        location: 'Mexico City',
        skills: 'react, typescript',
        applied_for: '1'
    };

    it('coerces multipart strings and lowercases email', () => {
        const r = schemas.publicApplyBody.safeParse(valid);
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.applied_for).toBe(1);
            expect(r.data.experience).toBe(5);
            expect(r.data.email).toBe('ana.garcia@example.com');
        }
    });

    it('rejects missing required fields and non-numeric applied_for', () => {
        const { email: _e, ...noEmail } = valid;
        void _e;
        expect(schemas.publicApplyBody.safeParse(noEmail).success).toBe(false);
        expect(schemas.publicApplyBody.safeParse({ ...valid, applied_for: 'abc' }).success).toBe(false);
    });
});

describe('processFeedbackBody schema', () => {
    it('requires candidateId, vacancyId and feedback', () => {
        expect(
            schemas.processFeedbackBody.safeParse({ candidateId: '3', vacancyId: '7', feedback: 'good' }).success
        ).toBe(true);
        expect(schemas.processFeedbackBody.safeParse({ candidateId: '3', feedback: 'good' }).success).toBe(false);
        expect(schemas.processFeedbackBody.safeParse({ candidateId: '3', vacancyId: '7', feedback: ' ' }).success).toBe(
            false
        );
    });
});
