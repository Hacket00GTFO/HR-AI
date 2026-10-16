import { describe, expect, it, vi } from 'vitest';
import { runSyncCycle, type SyncDeps } from '../src/sync.js';
import {
    recordingLogger,
    stubFetch,
    stubIdentityPool,
    stubMetrics,
    testConfig,
    TOKEN,
    type FetchCall
} from './helpers.js';

const REC = 'http://recruitment-core:3009';
const HRC = 'http://hr-core:3010';
const HRS = 'http://hr-services:3014';

function userRows(n: number, deletedIds: number[] = []): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        first_name: `First${i + 1}`,
        last_name: `Last${i + 1}`,
        email: `user${i + 1}@example.com`,
        deleted: deletedIds.includes(i + 1)
    }));
}

function makeDeps(overrides: Partial<SyncDeps> = {}): SyncDeps & { calls: FetchCall[] } {
    const { fetchImpl, calls } = stubFetch((call) => {
        if (call.method === 'GET' && call.url === `${HRC}/v1/employees`) return { data: [] };
        return { data: { upserted: 1 } };
    });
    const { log } = recordingLogger();
    const { metrics } = stubMetrics();
    const deps: SyncDeps = {
        pool: stubIdentityPool([]),
        config: testConfig(),
        log,
        metrics,
        fetchImpl,
        ...overrides
    };
    return Object.assign(deps, { calls });
}

const to = (calls: FetchCall[], base: string, path: string, method = 'POST') =>
    calls.filter((c) => c.method === method && c.url === `${base}${path}`);

describe('runSyncCycle', () => {
    it('batches users-projection pushes at SYNC_BATCH_SIZE with per-target payload shapes', async () => {
        const deps = makeDeps({ pool: stubIdentityPool(userRows(1200)) });
        const statuses = await runSyncCycle(deps);

        expect(statuses['recruitment_core.users_projection']).toBe('ok');
        expect(statuses['hr_core.users_projection']).toBe('ok');

        // recruitment-core: 3 batches of 500/500/200, email included.
        const recPosts = to(deps.calls, REC, '/v1/internal/users-projection');
        expect(recPosts).toHaveLength(3);
        expect(recPosts.map((c) => (c.body as { users: unknown[] }).users.length)).toEqual([500, 500, 200]);
        for (const call of recPosts) {
            expect(call.headers['X-Service-Token']).toBe(TOKEN);
            for (const u of (call.body as { users: Record<string, unknown>[] }).users) {
                expect(Object.keys(u).sort()).toEqual(['email', 'firstName', 'id', 'lastName']);
            }
        }

        // hr-core: same batching, strict schema — email must NOT be present.
        const hrcPosts = to(deps.calls, HRC, '/v1/internal/users-projection');
        expect(hrcPosts).toHaveLength(3);
        for (const call of hrcPosts) {
            for (const u of (call.body as { users: Record<string, unknown>[] }).users) {
                expect(Object.keys(u).sort()).toEqual(['firstName', 'id', 'lastName']);
            }
        }
    });

    it('maps hr-core employees to the employee-directory contract and skips rows without userId', async () => {
        const { fetchImpl, calls } = stubFetch((call) => {
            if (call.method === 'GET' && call.url === `${HRC}/v1/employees`) {
                return {
                    data: [
                        { id: 10, userId: 1, firstName: 'Ana', lastName: 'Lopez', department: 'Ops', salary: 99 },
                        { id: 11, userId: null, firstName: 'No', lastName: 'User', department: null },
                        { id: 12, userId: 3, firstName: 'Bo', lastName: 'Ra', department: null }
                    ]
                };
            }
            return { data: { upserted: 2 } };
        });
        const deps = makeDeps({ fetchImpl, pool: stubIdentityPool(userRows(1)) });
        const statuses = await runSyncCycle(deps);

        expect(statuses['hr_services.employee_directory']).toBe('ok');
        // The stubbed GET is what feeds the push.
        expect(to(calls, HRC, '/v1/employees', 'GET')).toHaveLength(1);
        expect(to(calls, HRC, '/v1/employees', 'GET')[0]?.headers['X-Service-Token']).toBe(TOKEN);

        const posts = to(calls, HRS, '/v1/internal/employee-directory');
        expect(posts).toHaveLength(1);
        const body = posts[0]?.body as { employees: Record<string, unknown>[] };
        // userId:null employee skipped; exactly the contract keys survive
        // (salary and other hr-core fields are stripped).
        expect(body.employees).toEqual([
            { id: 10, userId: 1, firstName: 'Ana', lastName: 'Lopez', department: 'Ops' },
            { id: 12, userId: 3, firstName: 'Bo', lastName: 'Ra', department: null }
        ]);
    });

    it('a failing target does not block the others', async () => {
        const { fetchImpl, calls } = stubFetch((call) => {
            if (call.url.startsWith(REC)) return { status: 500, data: { error: 'boom' } };
            if (call.method === 'GET' && call.url === `${HRC}/v1/employees`) {
                return { data: [{ id: 7, userId: 2, firstName: 'X', lastName: 'Y', department: 'IT' }] };
            }
            return { data: { upserted: 1 } };
        });
        const { metrics, runs } = stubMetrics();
        const deps = makeDeps({ fetchImpl, metrics, pool: stubIdentityPool(userRows(2)) });
        const statuses = await runSyncCycle(deps);

        expect(statuses['recruitment_core.users_projection']).toBe('error');
        expect(statuses['hr_core.users_projection']).toBe('ok');
        expect(statuses['hr_services.employee_directory']).toBe('ok');

        // hr-core + hr-services pushes still happened.
        expect(to(calls, HRC, '/v1/internal/users-projection')).toHaveLength(1);
        expect(to(calls, HRS, '/v1/internal/employee-directory')).toHaveLength(1);
        expect(runs).toContainEqual({
            labels: { step: 'recruitment_core.users_projection', status: 'error' },
            value: 1
        });
    });

    it('marks dependent pushes skipped when a source read fails', async () => {
        const { fetchImpl, calls } = stubFetch((call) => {
            if (call.method === 'GET' && call.url === `${HRC}/v1/employees`) return { data: [] };
            return { data: {} };
        });
        const deps = makeDeps({
            fetchImpl,
            pool: stubIdentityPool(new Error('connection refused'))
        });
        const statuses = await runSyncCycle(deps);

        expect(statuses['identity_users.read']).toBe('error');
        expect(statuses['recruitment_core.users_projection']).toBe('skipped');
        expect(statuses['hr_core.users_projection']).toBe('skipped');
        // The employee pipeline is independent — still ran.
        expect(statuses['hr_core.employees_read']).toBe('ok');
        expect(statuses['hr_services.employee_directory']).toBe('ok');
        expect(to(calls, REC, '/v1/internal/users-projection')).toHaveLength(0);
        expect(to(calls, HRC, '/v1/internal/users-projection')).toHaveLength(0);
    });

    it('propagates identity tombstones as DELETEs and tolerates 404s', async () => {
        const { fetchImpl, calls } = stubFetch((call) => {
            if (call.method === 'GET') return { data: [] };
            if (call.method === 'DELETE' && call.url === `${REC}/v1/internal/users-projection/5`) {
                return { status: 404, data: { error: 'not found' } };
            }
            if (call.method === 'DELETE') return { status: 204 };
            return { data: { upserted: 1 } };
        });
        const deps = makeDeps({ fetchImpl, pool: stubIdentityPool(userRows(6, [2, 5])) });
        const statuses = await runSyncCycle(deps);

        expect(statuses['recruitment_core.users_projection']).toBe('ok');
        expect(statuses['hr_core.users_projection']).toBe('ok');

        for (const base of [REC, HRC]) {
            expect(to(calls, base, '/v1/internal/users-projection/2', 'DELETE')).toHaveLength(1);
            expect(to(calls, base, '/v1/internal/users-projection/5', 'DELETE')).toHaveLength(1);
        }
        // Upserts only carried the 4 live users.
        const recPost = to(calls, REC, '/v1/internal/users-projection')[0];
        expect((recPost?.body as { users: unknown[] }).users).toHaveLength(4);
    });

    it('retries transient failures with exponential backoff', async () => {
        let attempts = 0;
        const { fetchImpl } = stubFetch((call) => {
            if (call.method === 'GET' && call.url === `${HRC}/v1/employees`) {
                attempts += 1;
                return attempts < 3 ? { status: 503 } : { data: [] };
            }
            return { data: { upserted: 1 } };
        });
        const sleep = vi.fn(async (_ms: number) => {});
        const deps = makeDeps({
            fetchImpl,
            sleep,
            config: testConfig({ SYNC_RETRY_MAX: '3', SYNC_RETRY_BASE_MS: '100' })
        });
        const statuses = await runSyncCycle(deps);

        expect(statuses['hr_core.employees_read']).toBe('ok');
        expect(attempts).toBe(3);
        // 100ms then 200ms — base * 2^(attempt-1).
        expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    });

    it('does not retry non-transient 4xx responses', async () => {
        let posts = 0;
        const { fetchImpl } = stubFetch((call) => {
            if (call.method === 'GET') return { data: [] };
            if (call.url.startsWith(REC)) {
                posts += 1;
                return { status: 400, data: { error: 'bad payload' } };
            }
            return { data: {} };
        });
        const sleep = vi.fn(async (_ms: number) => {});
        const deps = makeDeps({
            fetchImpl,
            sleep,
            pool: stubIdentityPool(userRows(1)),
            config: testConfig({ SYNC_RETRY_MAX: '3', SYNC_RETRY_BASE_MS: '1' })
        });
        const statuses = await runSyncCycle(deps);

        expect(statuses['recruitment_core.users_projection']).toBe('error');
        expect(posts).toBe(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('never logs PII — row counts and error classes only', async () => {
        const { fetchImpl } = stubFetch((call) => {
            if (call.method === 'GET' && call.url === `${HRC}/v1/employees`) {
                return {
                    data: [{ id: 9, userId: 1, firstName: 'SecretName', lastName: 'SecretLast', department: 'Fin' }]
                };
            }
            if (call.url.startsWith(HRS)) return { status: 500, data: { error: 'upstream said user1@example.com' } };
            return { data: { upserted: 1 } };
        });
        const { log, entries } = recordingLogger();
        const deps = makeDeps({ fetchImpl, log, pool: stubIdentityPool(userRows(3)) });
        await runSyncCycle(deps);

        expect(entries.length).toBeGreaterThan(0);
        const blob = JSON.stringify(entries);
        // No names, emails or upstream bodies in any log line.
        expect(blob).not.toContain('user1@example.com');
        expect(blob).not.toContain('First1');
        expect(blob).not.toContain('Last1');
        expect(blob).not.toContain('SecretName');
        expect(blob).not.toContain('SecretLast');
        // Sanity: the cycle summary logged counts only.
        const summary = entries.find((e) => e.msg === 'sync cycle finished');
        expect(summary?.obj).toMatchObject({ users: 3, employees: 1 });
    });

    it('records per-step row and duration metrics', async () => {
        const { metrics, rows, durations } = stubMetrics();
        const deps = makeDeps({ metrics, pool: stubIdentityPool(userRows(3)) });
        await runSyncCycle(deps);

        expect(rows).toContainEqual({ labels: { step: 'identity_users.read' }, value: 3 });
        expect(rows).toContainEqual({ labels: { step: 'recruitment_core.users_projection' }, value: 3 });
        const steps = durations.map((d) => d.step);
        for (const s of [
            'identity_users.read',
            'hr_core.employees_read',
            'recruitment_core.users_projection',
            'hr_core.users_projection',
            'hr_services.employee_directory'
        ]) {
            expect(steps).toContain(s);
        }
    });
});
