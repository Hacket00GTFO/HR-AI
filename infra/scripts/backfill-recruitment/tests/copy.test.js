import { describe, it, expect } from 'vitest';
import { copyTable, fixSequences } from '../lib/copy.js';
import { byName } from '../lib/plan.js';
import { makeFakeDb, makeFakeTarget } from './helpers.js';

const skills = byName.get('skills');
const cs = byName.get('candidate_skills');
const up = byName.get('users_projection');

const skillRows = (n) =>
    Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        name: `skill-${i + 1}`,
        esco_uri: null,
        created_at: `2024-01-0${(i % 9) + 1}T00:00:00Z`
    }));

describe('copyTable', () => {
    it('copies all rows in keyset-paginated batches', async () => {
        const src = makeFakeDb(skills, skillRows(7));
        const dst = makeFakeTarget(skills);
        const res = await copyTable(skills, src, dst, { batchSize: 3 });
        expect(res).toEqual({ table: 'skills', copied: 7, skipped: false });
        expect(dst.store.size).toBe(7);
        // 3 batches: BEGIN/COMMIT pairs bracket each INSERT
        const begins = dst.calls.filter((c) => c.sql === 'BEGIN').length;
        expect(begins).toBe(3);
        const inserts = dst.calls.filter((c) => c.sql.startsWith('INSERT'));
        expect(inserts[0].sql).toContain('ON CONFLICT ("id") DO NOTHING');
    });

    it('is idempotent — pre-existing rows are conflict-skipped', async () => {
        const src = makeFakeDb(skills, skillRows(5));
        const dst = makeFakeTarget(skills, skillRows(5).slice(0, 4));
        const res = await copyTable(skills, src, dst, { batchSize: 2 });
        expect(res.copied).toBe(1);
        expect(dst.store.size).toBe(5);
    });

    it('composite-pk tables paginate on (candidate_id, skill_id)', async () => {
        const rows = [];
        for (let c = 1; c <= 3; c += 1)
            for (let s = 1; s <= 4; s += 1) rows.push({ candidate_id: c, skill_id: s, created_at: 't' });
        const src = makeFakeDb(cs, rows);
        const dst = makeFakeTarget(cs);
        const res = await copyTable(cs, src, dst, { batchSize: 5 });
        expect(res.copied).toBe(12);
        expect(dst.store.size).toBe(12);
        // keyset predicate with row comparison was used
        const selects = src.calls.filter((c) => c.sql.includes('ORDER BY'));
        // batch 1 ends at (c2,s1) → next page starts after it
        expect(selects[1].params.slice(0, 2)).toEqual([2, 1]);
    });

    it('rolls back the failed batch and propagates the error', async () => {
        const src = makeFakeDb(skills, skillRows(4));
        const dst = makeFakeTarget(skills);
        const orig = dst.query;
        dst.query = async (sql, p) => {
            if (sql.startsWith('INSERT') && p[0] === 3) throw new Error('boom');
            return orig(sql, p);
        };
        await expect(copyTable(skills, src, dst, { batchSize: 2 })).rejects.toThrow('boom');
        expect(dst.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
        // first batch (ids 1-2) committed, second rolled back
        expect(dst.store.size).toBe(2);
    });

    it('optional spec skips cleanly when the source table is absent', async () => {
        const src = makeFakeDb(up, [], { exists: false, table: 'users' });
        const dst = makeFakeTarget(up);
        const res = await copyTable(up, src, dst, { batchSize: 10 });
        expect(res.skipped).toBe(true);
        expect(dst.calls.filter((c) => c.sql.startsWith('INSERT'))).toHaveLength(0);
    });
});

describe('fixSequences', () => {
    it('setvals every spec with a sequence, skips sequenceless tables', async () => {
        const specs = [skills, cs];
        const dst = { query: async () => ({ rows: [{ v: '7' }] }), calls: [] };
        const q = dst.query;
        dst.query = async (sql, p) => {
            dst.calls.push({ sql, p });
            return q(sql, p);
        };
        await fixSequences(specs, dst);
        expect(dst.calls).toHaveLength(1);
        expect(dst.calls[0].p).toEqual(['skills', 'id']);
    });
});
