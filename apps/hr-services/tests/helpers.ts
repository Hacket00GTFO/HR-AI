// Shared test scaffolding: a stubbed pg Pool (no live DB — same pattern as
// apps/hr-core tests), an outbox-aware query wrapper, a recording event
// publisher and a silent logger.
import { vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { ServiceLogger } from '@strafor/node-common';
import type { EventPublisher } from '../src/events.js';
import { loadConfig, type ServiceConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { Express } from 'express';

export const HR = { 'X-User-Id': '2', 'X-User-Role': 'hr' };
export const ADMIN = { 'X-User-Id': '1', 'X-User-Role': 'admin' };
export const SERVICE = { 'X-Service-Token': 'test-service-token' };
// User 10 → employee 100 (Engineering), user 11 → employee 200 (Sales).
export const EMP_A = { 'X-User-Id': '10', 'X-User-Role': 'employee' };
export const EMP_B = { 'X-User-Id': '11', 'X-User-Role': 'employee' };

export const EMPLOYEE_ID_A = 100;
export const EMPLOYEE_ID_B = 200;

export const silentLog = new Proxy({} as never, {
    get: () => () => {}
}) as ServiceLogger;

type SqlResult = { rows?: Record<string, unknown>[]; rowCount?: number };
export type SqlHandler = (text: string, params: unknown[]) => SqlResult | undefined;

export interface StubPool {
    pool: Pool;
    calls: Array<{ text: string; params: unknown[] }>;
    queryTexts(): string[];
}

/** Default directory mapping used by requireEmployee in tests. */
const DIRECTORY: Record<number, { id: number; department: string }> = {
    10: { id: EMPLOYEE_ID_A, department: 'Engineering' },
    11: { id: EMPLOYEE_ID_B, department: 'Sales' }
};

/**
 * Minimal Pool stand-in. `connect()` returns a client whose query delegates
 * to the same handler, so transactional paths (BEGIN/COMMIT/ROLLBACK) are
 * recorded in `calls` too.
 *
 * The wrapper emulates two platform behaviours the tests rely on:
 *   - employee_directory lookups by user_id (requireEmployee) and by id
 *     (survey respondent group), resolved from DIRECTORY;
 *   - the transactional outbox: INSERT INTO outbox_events rows are captured
 *     and served back to flushOutbox's pending SELECT so publish assertions
 *     on the recording publisher work end-to-end.
 */
export function stubPool(handler?: SqlHandler): StubPool {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const outboxRows: Array<Record<string, unknown>> = [];
    let nextOutboxId = 1;

    const query = vi.fn(async (text: string, params: unknown[] = []): Promise<QueryResult> => {
        calls.push({ text, params });

        // employee_directory lookup by user_id (requireEmployee).
        if (text.includes('FROM employee_directory WHERE user_id')) {
            const d = DIRECTORY[Number(params[0])];
            return result(d ? [{ id: d.id }] : []);
        }
        // directory lookup by employee id (respondent_group snapshot).
        if (text.includes('SELECT department FROM employee_directory WHERE id')) {
            const d = Object.values(DIRECTORY).find((x) => x.id === Number(params[0]));
            return result(d ? [{ department: d.department }] : []);
        }
        // Outbox emulation.
        if (text.includes('INSERT INTO outbox_events')) {
            const row = {
                id: nextOutboxId++,
                type: params[0],
                payload: typeof params[1] === 'string' ? JSON.parse(params[1] as string) : params[1],
                correlation_id: params[2] ?? null
            };
            outboxRows.push(row);
            return result([{ id: row.id }]);
        }
        if (text.includes('FROM outbox_events') && text.includes('published_at IS NULL')) {
            return result([...outboxRows]);
        }
        if (text.includes('UPDATE outbox_events')) {
            return { rows: [], rowCount: outboxRows.length } as unknown as QueryResult;
        }

        const out = handler ? await handler(text, params) : undefined;
        const rows = out?.rows ?? [];
        return {
            rows,
            rowCount: out?.rowCount ?? rows.length,
            command: '',
            oid: 0,
            fields: []
        } as unknown as QueryResult;
    });

    function result(rows: Record<string, unknown>[]): QueryResult {
        return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as unknown as QueryResult;
    }

    const client = {
        query: (t: string, p?: unknown[]) => query(t, p),
        release: vi.fn()
    } as unknown as PoolClient;
    const pool = {
        query,
        connect: vi.fn(async () => client),
        end: vi.fn(async () => {})
    } as unknown as Pool;
    return { pool, calls, queryTexts: () => calls.map((c) => c.text) };
}

export interface RecordingPublisher extends EventPublisher {
    published: Array<{ type: string; payload: Record<string, unknown> }>;
}

export function recordingPublisher(): RecordingPublisher {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    return {
        published,
        publish: vi.fn(async (_schema: unknown, type: string, payload: Record<string, unknown>) => {
            published.push({ type, payload });
            return true;
        }) as RecordingPublisher['publish'],
        close: vi.fn(async () => {})
    };
}

export function testConfig(): ServiceConfig {
    return loadConfig({
        DATABASE_URL: 'postgres://test:test@localhost:5432/strafor_services',
        SERVICE_AUTH_TOKEN: 'test-service-token',
        SURVEY_RESPONDENT_SALT: 'test-survey-salt-0123456789'
    });
}

export function testApp(handler?: SqlHandler): { app: Express; stub: StubPool; publisher: RecordingPublisher } {
    const stub = stubPool(handler);
    const publisher = recordingPublisher();
    const app = createApp({ pool: stub.pool, config: testConfig(), publisher, log: silentLog });
    return { app, stub, publisher };
}
