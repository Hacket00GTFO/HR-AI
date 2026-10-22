// Vacancy status canonicalization — the API schema and the DB CHECK now agree
// on {Draft, Active, Paused, Closed, Archived} (migration 0002). Before the
// fix, PUT status:'Paused' passed validation but died on the constraint, and
// 'Archived' was writable in SQL but rejected by the API.
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

vi.mock('../src/models/skill.js', () => ({
    syncVacancySkills: vi.fn(),
    syncCandidateSkills: vi.fn(),
    upsertSkill: vi.fn(),
    namesForCandidate: vi.fn(),
    namesForVacancy: vi.fn(),
    parseCsv: vi.fn(),
    parseList: vi.fn()
}));

vi.mock('../src/serviceClient.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/serviceClient.js')>();
    return { ...orig, callService: vi.fn(), uploadDocument: vi.fn(), fetchDocumentDownload: vi.fn() };
});

import * as Vacancy from '../src/models/vacancy.js';
import * as schemas from '../src/schemas.js';
import { makeApp, makeDeps, makeFakeDb, HR_HEADERS, ADMIN_HEADERS } from './helpers.js';

const CANONICAL = ['Draft', 'Active', 'Paused', 'Closed', 'Archived'] as const;

function app() {
    const db = makeFakeDb([
        // PUT locks the row first — pretend it exists.
        ['for update', [{ id: 1 }]]
    ]);
    return { app: makeApp(makeDeps({ pool: db.pool })), client: db.client } as {
        app: Express;
        client: ReturnType<typeof makeFakeDb>['client'];
    };
}

beforeEach(() => {
    vi.mocked(Vacancy.findById).mockReset().mockResolvedValue({ id: 1, title: 'FE' });
});

describe('vacancyStatus schema (canonicalization on write)', () => {
    it('accepts every canonical status', () => {
        for (const status of CANONICAL) {
            expect(schemas.vacancyUpdateBody.safeParse({ status }).success).toBe(true);
        }
    });

    it('normalizes case-variant input to the canonical spelling', () => {
        for (const [input, expected] of [
            ['paused', 'Paused'],
            ['ARCHIVED', 'Archived'],
            ['draft', 'Draft'],
            ['active', 'Active'],
            ['closed', 'Closed']
        ] as const) {
            const r = schemas.vacancyUpdateBody.safeParse({ status: input });
            expect(r.success).toBe(true);
            if (r.success) expect(r.data.status).toBe(expected);
        }
    });

    it('rejects non-canonical statuses', () => {
        for (const bad of ['exploding', 'Published', 'open', '']) {
            expect(schemas.vacancyUpdateBody.safeParse({ status: bad }).success).toBe(false);
        }
    });
});

describe('PUT /v1/vacancies/:id status transitions', () => {
    it.each(CANONICAL)('writes canonical status %s straight through to the DB', async (status) => {
        const { app: localApp, client } = app();
        const res = await request(localApp).put('/v1/vacancies/1').set(HR_HEADERS).send({ status });
        expect(res.status).toBe(200);
        const update = client.calls.find((c) => c.sql.toLowerCase().startsWith('update vacancies set'));
        expect(update).toBeTruthy();
        expect(update!.sql).toContain('status = $');
        expect(update!.params).toContain(status);
    });

    it('stores the canonical capitalization for case-variant input', async () => {
        const { app: localApp, client } = app();
        const res = await request(localApp).put('/v1/vacancies/1').set(HR_HEADERS).send({ status: 'paused' });
        expect(res.status).toBe(200);
        const update = client.calls.find((c) => c.sql.toLowerCase().startsWith('update vacancies set'));
        expect(update!.params).toContain('Paused');
        expect(update!.params).not.toContain('paused');
    });

    it('400 on a status outside the canonical set', async () => {
        const { app: localApp, client } = app();
        const res = await request(localApp).put('/v1/vacancies/1').set(HR_HEADERS).send({ status: 'Published' });
        expect(res.status).toBe(400);
        expect(client.calls.some((c) => c.sql.toLowerCase().startsWith('update vacancies'))).toBe(false);
    });

    it('403 for admin on the status write path', async () => {
        const { app: localApp } = app();
        const res = await request(localApp).put('/v1/vacancies/1').set(ADMIN_HEADERS).send({ status: 'Paused' });
        expect(res.status).toBe(403);
    });
});
