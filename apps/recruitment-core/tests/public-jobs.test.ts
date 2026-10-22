// GET /v1/public/jobs — anonymous careers listing: open vacancies only, in a
// reduced public-safe shape (no salary columns, no external_postings, no
// internal refs). Route test mocks the model; the model-level test asserts
// the SQL contract directly.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('../src/models/vacancy.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/models/vacancy.js')>();
    return {
        ...orig,
        find: vi.fn(),
        findById: vi.fn(),
        findOpen: vi.fn(),
        create: vi.fn(),
        softDeleteById: vi.fn()
    };
});

import * as Vacancy from '../src/models/vacancy.js';
import { makeApp, makeDeps, makeFakeDb, ADMIN_HEADERS } from './helpers.js';
import type { Queryable } from '../src/db.js';

const OPEN_JOB = {
    id: 3,
    title: 'Backend Engineer',
    company: 'Tech Mahindra',
    department: 'Engineering',
    location: 'Guadalajara, Mexico',
    employment_type: 'Full-time',
    description: 'Build APIs',
    requirements: 'Node, Postgres',
    responsibilities: 'Ship services',
    skills_required: ['node', 'postgres'],
    experience_level: 'Mid Level',
    benefits: ['Health'],
    remote_option: true,
    application_deadline: null,
    published_at: '2026-02-01T00:00:00.000Z',
    _id: '3'
};

let app: Express;

beforeAll(() => {
    const { pool } = makeFakeDb();
    app = makeApp(makeDeps({ pool }));
});

beforeEach(() => {
    vi.mocked(Vacancy.findOpen).mockReset().mockResolvedValue([OPEN_JOB]);
});

describe('GET /v1/public/jobs', () => {
    it('is anonymous — no headers needed, admin headers irrelevant', async () => {
        const anon = await request(app).get('/v1/public/jobs');
        expect(anon.status).toBe(200);
        expect(anon.body).toEqual([OPEN_JOB]);

        const withAdmin = await request(app).get('/v1/public/jobs').set(ADMIN_HEADERS);
        expect(withAdmin.status).toBe(200);
    });

    it('returns the public-safe shape (employment_type + published_at, no salary)', async () => {
        const res = await request(app).get('/v1/public/jobs');
        expect(res.status).toBe(200);
        const job = res.body[0];
        for (const key of ['id', 'title', 'location', 'employment_type', 'published_at']) {
            expect(job).toHaveProperty(key);
        }
        // Salary and internal fields must not appear on the public surface.
        for (const key of [
            'salary_min',
            'salary_max',
            'salary_currency',
            'salary_range',
            'external_postings',
            'created_by',
            'created_by_user_id',
            'deleted_at'
        ]) {
            expect(job).not.toHaveProperty(key);
        }
    });
});

describe('Vacancy.findOpen (model SQL contract)', () => {
    it('filters to open vacancies and never selects salary/internal columns', async () => {
        const calls: Array<{ sql: string; params: unknown[] }> = [];
        const db: Queryable = {
            query: vi.fn(async (sql: string, params: unknown[] = []) => {
                calls.push({ sql, params });
                return { rows: [], rowCount: 0 };
            })
        } as unknown as Queryable;

        // Bypass the mock — exercise the real model.
        const real = await vi.importActual<typeof Vacancy>('../src/models/vacancy.js');
        await real.findOpen(db);

        const sql = calls[0]!.sql.toLowerCase();
        expect(sql).toContain("v.status = 'active'");
        expect(sql).toContain('deleted_at is null');
        expect(sql).toContain('as employment_type');
        expect(sql).toContain('as published_at');
        expect(sql).not.toContain('salary');
        expect(sql).not.toContain('external_postings');
        expect(sql).not.toContain('created_by');
    });
});
