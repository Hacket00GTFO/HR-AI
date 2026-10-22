import { describe, it, expect } from 'vitest';
import { parseArgs, resolvePlan, defaultUrls } from '../run.js';

describe('parseArgs', () => {
    it('defaults to copy mode with batch 1000', () => {
        const o = parseArgs([]);
        expect(o.mode).toBe('copy');
        expect(o.batch).toBe(1000);
        expect(o.dryRun).toBe(false);
    });

    it('parses flags', () => {
        const o = parseArgs([
            '--mode=verify',
            '--batch=250',
            '--dry-run',
            '--truncate',
            '--tables=skills,vacancies',
            '--skip=users_projection',
            '--diff-limit=10',
            '--source=postgres://a:b@s/dbs',
            '--target=postgres://a:b@t/dbt'
        ]);
        expect(o.mode).toBe('verify');
        expect(o.batch).toBe(250);
        expect(o.dryRun).toBe(true);
        expect(o.truncate).toBe(true);
        expect(o.tables).toEqual(['skills', 'vacancies']);
        expect([...o.skip]).toEqual(['users_projection']);
        expect(o.diffLimit).toBe(10);
        expect(o.source).toContain('@s/');
        expect(o.target).toContain('@t/');
    });

    it('rejects unknown args and bad batch', () => {
        expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
        expect(() => parseArgs(['--batch=0'])).toThrow(/--batch/);
    });
});

describe('resolvePlan', () => {
    it('returns the full ordered plan by default', () => {
        const specs = resolvePlan(parseArgs([]));
        expect(specs[0].name).toBe('skills');
        expect(specs[specs.length - 1].name).toBe('users_projection');
    });
    it('honours --tables and --skip', () => {
        const specs = resolvePlan(parseArgs(['--tables=skills,vacancies']));
        expect(specs.map((s) => s.name)).toEqual(['skills', 'vacancies']);
        const skipped = resolvePlan(parseArgs(['--skip=users_projection']));
        expect(skipped.map((s) => s.name)).not.toContain('users_projection');
    });
    it('--tables preserves declared plan order', () => {
        const specs = resolvePlan(parseArgs(['--tables=applications,skills']));
        expect(specs.map((s) => s.name)).toEqual(['skills', 'applications']);
    });
    it('rejects unknown table names', () => {
        expect(() => resolvePlan(parseArgs(['--tables=nope']))).toThrow(/Unknown table/);
    });
});

describe('defaultUrls', () => {
    it('points at the two DBs on the compose network', () => {
        const u = defaultUrls();
        expect(u.source).toMatch(/@db:5432\/innovation$/);
        expect(u.target).toMatch(/@db:5432\/strafor_recruitment$/);
    });
});
