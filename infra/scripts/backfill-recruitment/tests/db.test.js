import { describe, it, expect } from 'vitest';
import {
    buildBatchSelect,
    buildInsert,
    buildChecksum,
    buildHashPageSelect,
    buildHashRangeSelect,
    buildSetval,
    pkCursorWhere,
    rowToValues,
    pkCursorOf,
    redact,
    quoteIdent
} from '../lib/db.js';
import { TABLES, byName } from '../lib/plan.js';

const skills = byName.get('skills');
const cs = byName.get('candidate_skills');

describe('plan', () => {
    it('orders tables parents-before-children (FK-safe)', () => {
        const order = TABLES.map((t) => t.name);
        expect(order).toEqual([
            'skills',
            'vacancies',
            'candidates',
            'candidate_skills',
            'vacancy_skills',
            'applications',
            'application_status_history',
            'users_projection'
        ]);
    });

    it('maps users_projection ← monolith users table', () => {
        const up = byName.get('users_projection');
        expect(up.source).toBe('users');
        expect(up.optional).toBe(true);
        expect(up.columns).toEqual(['id', 'first_name', 'last_name', 'email']);
    });

    it('candidates mapping excludes target-only resume_document_id', () => {
        expect(byName.get('candidates').columns).not.toContain('resume_document_id');
        expect(byName.get('candidates').columns).toContain('resume');
    });
});

describe('pkCursorWhere', () => {
    it('single pk', () => {
        expect(pkCursorWhere(skills, 3)).toBe('"id" > $3');
    });
    it('composite pk uses row comparison', () => {
        expect(pkCursorWhere(cs, 2)).toBe('("candidate_id", "skill_id") > ($2, $3)');
    });
});

describe('buildBatchSelect', () => {
    it('no cursor → plain LIMIT', () => {
        const { sql, params } = buildBatchSelect(skills, 1000, null, 'skills');
        // created_at is a textCast column (timestamptz precision round-trip)
        expect(sql).toBe(
            'SELECT "id", "name", "esco_uri", "created_at"::text AS "created_at" ' +
                'FROM "skills"  ORDER BY "id" LIMIT $1'
        );
        expect(params).toEqual([1000]);
    });
    it('cursor → keyset predicate + LIMIT', () => {
        const { sql, params } = buildBatchSelect(skills, 500, [42], 'skills');
        expect(sql).toContain('WHERE "id" > $1');
        expect(sql).toContain('LIMIT $2');
        expect(params).toEqual([42, 500]);
    });
    it('composite pk cursor', () => {
        const { sql, params } = buildBatchSelect(cs, 100, [7, 9], 'candidate_skills');
        expect(sql).toContain('("candidate_id", "skill_id") > ($1, $2)');
        expect(params).toEqual([7, 9, 100]);
    });
});

describe('buildInsert', () => {
    it('parameterizes a multi-row insert with ON CONFLICT (pk)', () => {
        const sql = buildInsert(skills, 2);
        expect(sql).toBe(
            'INSERT INTO "skills" ("id", "name", "esco_uri", "created_at") ' +
                'VALUES ($1, $2, $3, $4), ($5, $6, $7, $8) ON CONFLICT ("id") DO NOTHING'
        );
    });
    it('composite pk conflict target', () => {
        const sql = buildInsert(cs, 1);
        expect(sql).toContain('ON CONFLICT ("candidate_id", "skill_id") DO NOTHING');
    });
});

describe('rowToValues / pkCursorOf', () => {
    it('flattens rows in column order', () => {
        const rows = [
            { id: 1, name: 'a', esco_uri: null, created_at: 'x' },
            { id: 2, name: 'b', esco_uri: 'e', created_at: 'y' }
        ];
        expect(rowToValues(skills, rows)).toEqual([1, 'a', null, 'x', 2, 'b', 'e', 'y']);
        expect(pkCursorOf(skills, rows[1])).toEqual([2]);
        expect(pkCursorOf(cs, { candidate_id: 3, skill_id: 4 })).toEqual([3, 4]);
    });
});

describe('checksum & hash selects', () => {
    it('checksum is order-independent (sum of row hashes)', () => {
        const sql = buildChecksum(skills, 'skills', skills.columns);
        expect(sql).toContain('count(*)::text AS n');
        expect(sql).toContain('sum(hashtextextended(row_to_json(t)::text, 0))');
        expect(sql).toContain('SELECT "id", "name", "esco_uri", "created_at" FROM "skills"');
    });
    it('users_projection checksum excludes service-managed updated_at', () => {
        const up = byName.get('users_projection');
        const sql = buildChecksum(up, 'users', up.verifyColumns);
        expect(sql).toContain('"id", "first_name", "last_name", "email"');
        expect(sql).not.toContain('updated_at');
        expect(sql).toContain('FROM "users"');
    });
    it('hash page and range selects carry pk + hash', () => {
        const page = buildHashPageSelect(cs, 100, [1, 2], 'candidate_skills', cs.columns);
        expect(page.sql).toContain('ORDER BY "candidate_id", "skill_id" LIMIT');
        const range = buildHashRangeSelect(cs, [1, 2], [9, 9], 'candidate_skills', cs.columns);
        expect(range.sql).toContain('("candidate_id", "skill_id") > ($1, $2)');
        expect(range.sql).toContain('("candidate_id", "skill_id") <= ($3, $4)');
        expect(range.params).toEqual([1, 2, 9, 9]);
        expect(range.sql).not.toContain('LIMIT');
    });
});

describe('buildSetval', () => {
    it('points the serial sequence at max(pk)', () => {
        const { sql, params } = buildSetval(skills);
        expect(sql).toContain('pg_get_serial_sequence($1, $2)');
        expect(sql).toContain('max("id")');
        expect(params).toEqual(['skills', 'id']);
    });
});

describe('utils', () => {
    it('redact masks the password', () => {
        expect(redact('postgres://u:secret@db:5432/innovation')).toBe('postgres://u:***@db:5432/innovation');
    });
    it('quoteIdent escapes double quotes', () => {
        expect(quoteIdent('we"ird')).toBe('"we""ird"');
    });
});
