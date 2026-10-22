import { describe, it, expect } from 'vitest';
import { verifyTable, findDivergent } from '../lib/verify.js';
import { byName } from '../lib/plan.js';
import { makeFakeDb } from './helpers.js';

const skills = byName.get('skills');
const up = byName.get('users_projection');

const skillRows = (n) =>
    Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        name: `skill-${i + 1}`,
        esco_uri: null,
        created_at: `2024-01-0${(i % 9) + 1}T00:00:00Z`
    }));

describe('verifyTable', () => {
    it('ok when count + checksum match', async () => {
        const rows = skillRows(10);
        const src = makeFakeDb(skills, rows);
        const dst = makeFakeDb(skills, rows);
        const res = await verifyTable(skills, src, dst);
        expect(res.ok).toBe(true);
    });

    it('mismatch on count difference, lists the missing pk', async () => {
        const src = makeFakeDb(skills, skillRows(10));
        const dst = makeFakeDb(skills, skillRows(9));
        const res = await verifyTable(skills, src, dst);
        expect(res.ok).toBe(false);
        expect(res.detail).toContain('count src=10 dst=9');
        expect(res.detail).toContain('missing on target');
    });

    it('mismatch on changed value (hash mismatch) even with equal counts', async () => {
        const src = makeFakeDb(skills, skillRows(5));
        const changed = skillRows(5);
        changed[2] = { ...changed[2], name: 'renamed' };
        const dst = makeFakeDb(skills, changed);
        const res = await verifyTable(skills, src, dst);
        expect(res.ok).toBe(false);
        expect(res.detail).toContain('hash mismatch');
        expect(res.detail).toContain('[3]');
    });

    it('flags extra rows on the target', async () => {
        const src = makeFakeDb(skills, skillRows(3));
        const dst = makeFakeDb(skills, skillRows(4));
        const res = await verifyTable(skills, src, dst);
        expect(res.ok).toBe(false);
        expect(res.detail).toContain('extra on target');
    });

    it('optional spec passes as skipped when source table absent', async () => {
        const src = makeFakeDb(up, [], { exists: false, table: 'users' });
        const dst = makeFakeDb(up, []);
        const res = await verifyTable(up, src, dst);
        expect(res.ok).toBe(true);
        expect(res.skipped).toBe(true);
    });
});

describe('findDivergent', () => {
    it('reports nothing for identical tables', async () => {
        const rows = skillRows(20);
        const src = makeFakeDb(skills, rows);
        const dst = makeFakeDb(skills, rows);
        expect(await findDivergent(skills, src, dst)).toEqual([]);
    });

    it('walks pk windows without false positives across page boundaries', async () => {
        // Source has 10 rows; dst missing an early row (2) and has a trailing
        // extra (99) beyond the source max — both must be reported exactly.
        const src = makeFakeDb(skills, skillRows(10));
        const dstRows = skillRows(10).filter((r) => r.id !== 2);
        dstRows.push({ id: 99, name: 'extra', esco_uri: null, created_at: 't' });
        const dst = makeFakeDb(skills, dstRows);
        const diffs = await findDivergent(skills, src, dst);
        const issues = diffs.map((d) => `${d.pk}:${d.issue}`).sort();
        expect(issues).toEqual(['[2]:missing on target', '[99]:extra on target'].sort());
    });
});
