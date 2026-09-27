import { describe, it, expect } from 'vitest';
import {
    applyBodySchema,
    applyFormSchema,
    loginBodySchema,
    salaryRangeSchema,
    vacancySchema,
    MAX_RESUME_BYTES
} from '@/lib/schemas';

describe('loginBodySchema', () => {
    it('accepts email + password', () => {
        expect(loginBodySchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    });
    it('rejects bad email / empty password', () => {
        expect(loginBodySchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
        expect(loginBodySchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
    });
});

describe('applyBodySchema (mirrors API publicApplyBody)', () => {
    const valid = {
        first_name: 'Ana',
        last_name: 'Garcia',
        email: 'ana@example.com',
        phone: '+52 55 0000',
        experience: '5',
        education: 'Bachelor',
        location: 'CDMX, Mexico',
        skills: 'react, typescript',
        applied_for: '3'
    };
    it('coerces multipart string fields to numbers', () => {
        const r = applyBodySchema.safeParse(valid);
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.experience).toBe(5);
            expect(r.data.applied_for).toBe(3);
        }
    });
    it('rejects missing required fields and bad emails', () => {
        const noEmail = { ...valid } as Record<string, unknown>;
        delete noEmail.email;
        expect(applyBodySchema.safeParse(noEmail).success).toBe(false);
        expect(applyBodySchema.safeParse({ ...valid, email: 'bad' }).success).toBe(false);
        expect(applyBodySchema.safeParse({ ...valid, applied_for: 'x' }).success).toBe(false);
    });
});

describe('applyFormSchema (client)', () => {
    const base = {
        first_name: 'Ana',
        last_name: 'Garcia',
        email: 'ana@example.com',
        phone: '123',
        linkedin: '',
        experience: 3,
        education: 'BSc',
        country: 'Mexico',
        state: 'CDMX',
        skills: ['react'],
        current_position: '',
        resume: null
    };
    it('accepts a complete form without a resume', () => {
        expect(applyFormSchema.safeParse(base).success).toBe(true);
    });
    it('requires at least one skill', () => {
        expect(applyFormSchema.safeParse({ ...base, skills: [] }).success).toBe(false);
    });
    it('rejects an oversized resume', () => {
        const big = new File([new Uint8Array(MAX_RESUME_BYTES + 1)], 'cv.pdf', { type: 'application/pdf' });
        const r = applyFormSchema.safeParse({ ...base, resume: big });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message === 'resumeTooLarge')).toBe(true);
        }
    });
    it('rejects a disallowed resume type', () => {
        const exe = new File([new Uint8Array(10)], 'cv.exe', { type: 'application/x-msdownload' });
        const r = applyFormSchema.safeParse({ ...base, resume: exe });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message === 'resumeBadType')).toBe(true);
        }
    });
    it('accepts a valid pdf resume', () => {
        const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'cv.pdf', { type: 'application/pdf' });
        expect(applyFormSchema.safeParse({ ...base, resume: pdf }).success).toBe(true);
    });
});

describe('vacancySchema', () => {
    it('parses the monolith wire shape incl. salary currency', () => {
        const r = vacancySchema.safeParse({
            id: 5,
            title: 'Backend Engineer',
            department: 'Engineering',
            location: 'Remote',
            type: 'Full-time',
            salary_range: { min: 40000, max: 60000, currency: 'MXN' },
            remote_option: true,
            status: 'Active'
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.salary_range?.currency).toBe('MXN');
    });
    it('salaryRangeSchema tolerates nulls', () => {
        expect(salaryRangeSchema.safeParse({ min: null, max: null, currency: null }).success).toBe(true);
        expect(salaryRangeSchema.safeParse(null).success).toBe(true);
    });
});
