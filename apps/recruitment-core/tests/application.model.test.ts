// Model-level tests for the real (unmocked) Application model — the SQL
// contract that guarantees a status transition always writes its history row
// inside the same transaction.
import { describe, it, expect, vi } from 'vitest';
import * as Application from '../src/models/application.js';
import type { Queryable } from '../src/db.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function recordingClient(handlers: Array<[string, Row[]]> = []) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: Queryable = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params });
            const lower = sql.toLowerCase();
            for (const [needle, rows] of handlers) {
                if (lower.includes(needle.toLowerCase())) return { rows, rowCount: rows.length };
            }
            return { rows: [], rowCount: 0 };
        })
    } as unknown as Queryable;
    return { client, calls };
}

describe('Application.updateStatus', () => {
    it('locks the row (FOR UPDATE), updates status, writes history, returns the legacy row', async () => {
        const { client, calls } = recordingClient([
            ['for update', [{ status: 'pending' }]],
            ['from applications a', [{ id: 7, application_id: 42, status: 'interview', _id: '7' }]]
        ]);

        const row = await Application.updateStatus({} as never, 42, 'INTERVIEW', { changedBy: 5, client });

        const sqls = calls.map((c) => c.sql.toLowerCase());
        const lockIdx = sqls.findIndex((s) => s.includes('for update'));
        const updateIdx = sqls.findIndex((s) => s.startsWith('update applications set status'));
        const historyIdx = sqls.findIndex((s) => s.includes('insert into application_status_history'));
        const selectIdx = sqls.findIndex((s) => s.includes('from applications a'));

        expect(lockIdx).toBeGreaterThanOrEqual(0);
        expect(updateIdx).toBeGreaterThan(lockIdx);
        expect(historyIdx).toBeGreaterThan(updateIdx);
        expect(selectIdx).toBeGreaterThan(historyIdx);

        // History row: (application_id, from_status, to_status, changed_by, note)
        expect(calls[historyIdx]!.params).toEqual([42, 'pending', 'interview', 5, null]);
        expect(row).toMatchObject({ application_id: 42, status: 'interview', _id: '7' });
    });

    it('returns null for a missing/deleted application', async () => {
        const { client, calls } = recordingClient(); // FOR UPDATE → no rows
        const row = await Application.updateStatus({} as never, 99, 'accepted', { client });
        expect(row).toBeNull();
        expect(calls.some((c) => c.sql.toLowerCase().includes('insert into'))).toBe(false);
    });

    it('rejects a non-canonical status with 400', async () => {
        const { client } = recordingClient();
        await expect(Application.updateStatus({} as never, 42, 'hired', { client })).rejects.toMatchObject({
            status: 400
        });
    });
});

describe('Application.updateById', () => {
    it('rejects non-whitelisted fields', async () => {
        const { client } = recordingClient();
        await expect(
            Application.updateById({} as never, 42, { candidate_id: 9, drop: 'x' }, { client })
        ).rejects.toMatchObject({ status: 400 });
    });

    it('writes history when status changes among other fields', async () => {
        const { client, calls } = recordingClient([
            ['for update', [{ status: 'interview' }]],
            ['returning *', [{ id: 42, status: 'accepted' }]]
        ]);
        await Application.updateById(
            {} as never,
            42,
            { status: 'accepted', hiring_feedback: 'strong hire' },
            { changedBy: 5, client }
        );
        const history = calls.find((c) => c.sql.toLowerCase().includes('insert into application_status_history'));
        expect(history).toBeTruthy();
        expect(history!.params).toEqual([42, 'interview', 'accepted', 5]);
    });

    it('does not write history for non-status updates', async () => {
        const { client, calls } = recordingClient([['returning *', [{ id: 42, status: 'accepted' }]]]);
        await Application.updateById(
            {} as never,
            42,
            { hiring_feedback: 'note', ai_feedback_analysis: { match_score: 0.9 } },
            { client }
        );
        expect(calls.some((c) => c.sql.toLowerCase().includes('insert into application_status_history'))).toBe(false);
        // ai_feedback_analysis is serialized to JSON before hitting the driver.
        const update = calls.find((c) => c.sql.toLowerCase().startsWith('update applications'));
        expect(update!.params[2]).toBe('{"match_score":0.9}');
    });
});

describe('Application.resolveForCandidate', () => {
    it('scopes to vacancy_id when given; latest application otherwise', async () => {
        const { client, calls } = recordingClient([['from applications', [{ id: 42 }]]]);
        await Application.resolveForCandidate(client, 7, 3);
        expect(calls[0]!.sql.toLowerCase()).toContain('and vacancy_id = $2');
        expect(calls[0]!.params).toEqual([7, 3]);

        await Application.resolveForCandidate(client, 7);
        expect(calls[1]!.sql.toLowerCase()).not.toContain('vacancy_id = $2');
        expect(calls[1]!.sql.toLowerCase()).toContain('order by applied_at desc');
    });
});
