// Sync cycle: read source sets, push upserts (+ tombstones) to each target.
//
// Design notes:
// - STATELESS: no local state table. Every cycle fetches the full source set
//   and pushes upserts; convergence happens via repeated upserts.
// - DELETES: propagated only when the source exposes tombstones. Identity
//   users carry `deleted_at` (soft delete) → we issue DELETE calls to each
//   users-projection target. hr-core's employee list only returns live rows
//   (soft-deleted employees are filtered server-side), so employee removals
//   do NOT propagate — stale employee_directory rows must be cleaned by the
//   owning service or a future tombstone source.
// - PII: only row COUNTS are ever logged — never names/emails. Upstream
//   response bodies are never read into errors (see client.ts).
// - INDEPENDENCE: each step is isolated; one failing target never blocks
//   the others. A failed source read marks its dependent pushes 'skipped'.
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ServiceLogger } from '@strafor/node-common';
import { callService, isRetryable, ServiceError } from './client.js';
import { withRetry } from './retry.js';
import type { ServiceConfig } from './config.js';
import type { SyncMetrics } from './metrics.js';

// ---------- source / target row shapes ----------

export interface IdentityUser {
    id: number;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    /** Tombstone — identity soft-deletes via deleted_at. */
    deleted: boolean;
}

export interface IdentityUsers {
    upserts: IdentityUser[];
    tombstones: number[];
}

export interface DirectoryEmployee {
    id: number;
    userId: number;
    firstName: string | null;
    lastName: string | null;
    department: string | null;
}

export interface EmployeeSet {
    employees: DirectoryEmployee[];
    /** Rows dropped because they have no linked identity user. */
    skipped: number;
}

export type StepStatus = 'ok' | 'error' | 'skipped';
export type StepName =
    | 'identity_users.read'
    | 'hr_core.employees_read'
    | 'recruitment_core.users_projection'
    | 'hr_core.users_projection'
    | 'hr_services.employee_directory';

export interface SyncDeps {
    /** pg Pool on the identity database (strafor_identity). */
    pool: Pool;
    config: ServiceConfig;
    log: ServiceLogger;
    metrics: SyncMetrics;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

// ---------- source readers ----------

const identityRowSchema = z.object({
    id: z.number().int().positive(),
    first_name: z.string().max(100).nullable(),
    last_name: z.string().max(100).nullable(),
    email: z.string().max(255).nullable(),
    deleted: z.boolean()
});

/** Read all identity users, split into live upserts and deleted-at tombstones. */
export async function readIdentityUsers(pool: Pool): Promise<IdentityUsers> {
    const { rows } = await pool.query(
        `SELECT id, first_name, last_name, email,
                (deleted_at IS NOT NULL) AS deleted
         FROM users
         ORDER BY id`
    );
    const upserts: IdentityUser[] = [];
    const tombstones: number[] = [];
    for (const raw of rows) {
        const r = identityRowSchema.parse(raw);
        if (r.deleted) {
            tombstones.push(r.id);
        } else {
            upserts.push({
                id: r.id,
                firstName: r.first_name,
                lastName: r.last_name,
                email: r.email,
                deleted: false
            });
        }
    }
    return { upserts, tombstones };
}

// hr-core GET /v1/employees row (subset — z.object strips the rest).
const hrEmployeeSchema = z.object({
    id: z.number().int().positive(),
    userId: z.number().int().positive().nullable(),
    firstName: z.string().max(100).nullable().optional(),
    lastName: z.string().max(100).nullable().optional(),
    department: z.string().max(100).nullable().optional()
});

/**
 * Fetch live hr-core employees via its service-token API and map them to the
 * employee-directory contract. Employees without a linked user account
 * (user_id IS NULL) cannot enter the projection and are counted as skipped.
 */
export async function readHrCoreEmployees(deps: SyncDeps): Promise<EmployeeSet> {
    const { config } = deps;
    const res = await callService(
        config.HR_CORE_URL,
        '/v1/employees',
        {
            method: 'GET',
            token: config.SERVICE_AUTH_TOKEN,
            timeout: config.SYNC_HTTP_TIMEOUT_MS
        },
        deps.fetchImpl ?? fetch
    );
    const parsed = z.array(hrEmployeeSchema).safeParse(res.data);
    if (!parsed.success) {
        throw new Error('hr-core employees response failed validation');
    }
    const employees: DirectoryEmployee[] = [];
    let skipped = 0;
    for (const e of parsed.data) {
        if (e.userId == null) {
            skipped += 1;
            continue;
        }
        employees.push({
            id: e.id,
            userId: e.userId,
            firstName: e.firstName ?? null,
            lastName: e.lastName ?? null,
            department: e.department ?? null
        });
    }
    return { employees, skipped };
}

// ---------- target pushers ----------

function chunks<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * Bulk-upsert a users-projection. `includeEmail` toggles the recruitment-core
 * shape — hr-core's endpoint has a STRICT schema without `email`.
 */
export async function pushUsersProjection(
    baseUrl: string,
    users: IdentityUser[],
    includeEmail: boolean,
    deps: SyncDeps
): Promise<number> {
    const { config } = deps;
    let pushed = 0;
    for (const batch of chunks(users, config.SYNC_BATCH_SIZE)) {
        const payload = {
            users: batch.map((u) =>
                includeEmail
                    ? { id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email }
                    : { id: u.id, firstName: u.firstName, lastName: u.lastName }
            )
        };
        await callService(
            baseUrl,
            '/v1/internal/users-projection',
            {
                method: 'POST',
                body: payload,
                token: config.SERVICE_AUTH_TOKEN,
                timeout: config.SYNC_HTTP_TIMEOUT_MS
            },
            deps.fetchImpl ?? fetch
        );
        pushed += batch.length;
    }
    return pushed;
}

/** Issue DELETEs for tombstoned ids; 404 means already gone — tolerated. */
export async function pushDeletes(baseUrl: string, resource: string, ids: number[], deps: SyncDeps): Promise<number> {
    const { config } = deps;
    let deleted = 0;
    for (const id of ids) {
        try {
            await callService(
                baseUrl,
                `/v1/internal/${resource}/${id}`,
                {
                    method: 'DELETE',
                    token: config.SERVICE_AUTH_TOKEN,
                    timeout: config.SYNC_HTTP_TIMEOUT_MS
                },
                deps.fetchImpl ?? fetch
            );
            deleted += 1;
        } catch (err) {
            if (err instanceof ServiceError && err.status === 404) continue;
            throw err;
        }
    }
    return deleted;
}

/** Bulk-upsert the hr-services employee-directory projection. */
export async function pushEmployeeDirectory(
    baseUrl: string,
    employees: DirectoryEmployee[],
    deps: SyncDeps
): Promise<number> {
    const { config } = deps;
    let pushed = 0;
    for (const batch of chunks(employees, config.SYNC_BATCH_SIZE)) {
        await callService(
            baseUrl,
            '/v1/internal/employee-directory',
            {
                method: 'POST',
                body: {
                    employees: batch.map((e) => ({
                        id: e.id,
                        userId: e.userId,
                        firstName: e.firstName,
                        lastName: e.lastName,
                        department: e.department
                    }))
                },
                token: config.SERVICE_AUTH_TOKEN,
                timeout: config.SYNC_HTTP_TIMEOUT_MS
            },
            deps.fetchImpl ?? fetch
        );
        pushed += batch.length;
    }
    return pushed;
}

// ---------- cycle ----------

const elapsedSeconds = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e9;

const errMessage = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/**
 * Run one full sync cycle. Never throws — every step is independently
 * retried (exponential backoff), metered and logged; a failed step marks its
 * status 'error' and the cycle moves on.
 */
export async function runSyncCycle(deps: SyncDeps): Promise<Record<StepName, StepStatus>> {
    const { config, log, metrics } = deps;
    const statuses = {} as Record<StepName, StepStatus>;
    const cycleStart = process.hrtime.bigint();

    const retry = {
        retries: config.SYNC_RETRY_MAX,
        baseMs: config.SYNC_RETRY_BASE_MS,
        retryable: isRetryable,
        ...(deps.sleep ? { sleep: deps.sleep } : {})
    };

    async function step<T>(name: StepName, fn: () => Promise<{ data: T; rows: number }>): Promise<T | null> {
        const start = process.hrtime.bigint();
        try {
            const { data, rows } = await withRetry(fn, {
                ...retry,
                onRetry: (attempt, err) => log.warn({ step: name, attempt, err: errMessage(err) }, 'sync step retrying')
            });
            metrics.runs.inc({ step: name, status: 'ok' });
            metrics.rows.inc({ step: name }, rows);
            metrics.duration.observe({ step: name }, elapsedSeconds(start));
            statuses[name] = 'ok';
            return data;
        } catch (err) {
            metrics.runs.inc({ step: name, status: 'error' });
            metrics.duration.observe({ step: name }, elapsedSeconds(start));
            statuses[name] = 'error';
            // Counts + error class only — never row payloads.
            log.error({ step: name, err: errMessage(err) }, 'sync step failed');
            return null;
        }
    }

    function skip(name: StepName): null {
        metrics.runs.inc({ step: name, status: 'skipped' });
        statuses[name] = 'skipped';
        return null;
    }

    // -- Step 1: read identity users (source of truth for display names). --
    const users = await step('identity_users.read', async () => {
        const r = await readIdentityUsers(deps.pool);
        return { data: r, rows: r.upserts.length + r.tombstones.length };
    });

    // -- Step 2: read hr-core employees (independent of step 1). --
    const employees = await step('hr_core.employees_read', async () => {
        const r = await readHrCoreEmployees(deps);
        return { data: r, rows: r.employees.length };
    });

    // -- Step 3: recruitment-core users-projection (upserts + tombstones). --
    if (users) {
        await step('recruitment_core.users_projection', async () => {
            const upserted = await pushUsersProjection(config.RECRUITMENT_CORE_URL, users.upserts, true, deps);
            const deleted = await pushDeletes(config.RECRUITMENT_CORE_URL, 'users-projection', users.tombstones, deps);
            return { data: null, rows: upserted + deleted };
        });
    } else {
        skip('recruitment_core.users_projection');
    }

    // -- Step 4: hr-core users-projection (strict schema — NO email field). --
    if (users) {
        await step('hr_core.users_projection', async () => {
            const upserted = await pushUsersProjection(config.HR_CORE_URL, users.upserts, false, deps);
            const deleted = await pushDeletes(config.HR_CORE_URL, 'users-projection', users.tombstones, deps);
            return { data: null, rows: upserted + deleted };
        });
    } else {
        skip('hr_core.users_projection');
    }

    // -- Step 5: hr-services employee-directory (upserts only — the source
    //    exposes no tombstones, so hard deletes cannot propagate). --
    if (employees) {
        await step('hr_services.employee_directory', async () => {
            const upserted = await pushEmployeeDirectory(config.HR_SERVICES_URL, employees.employees, deps);
            return { data: null, rows: upserted };
        });
    } else {
        skip('hr_services.employee_directory');
    }

    // Cycle summary — row counts only, no PII.
    log.info(
        {
            users: users?.upserts.length ?? null,
            userTombstones: users?.tombstones.length ?? null,
            employees: employees?.employees.length ?? null,
            employeesSkipped: employees?.skipped ?? null,
            durationMs: Math.round(elapsedSeconds(cycleStart) * 1000)
        },
        'sync cycle finished'
    );
    return statuses;
}
